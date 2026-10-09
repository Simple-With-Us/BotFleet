// A small fake Zulip server for the Zulip source tests.
//
// `node:http` on 127.0.0.1 with a random port.  It implements only the
// endpoints server/zulip/ uses, checks Basic auth, records every request, and
// can inject faults (429s, an expired queue).  Its semantics follow the
// fleet's own fake (AFC scripts/agent_sync/tests/fake_zulip.py), which was
// checked against the live realm:
//
//   - POST /register creates a queue; GET /events long-polls it (with a short
//     heartbeat so tests stay fast) and acknowledges events up to
//     last_event_id; an unknown queue answers BAD_EVENT_QUEUE_ID.
//   - Message events carry `flags` on the EVENT, not inside the message.
//     GET /messages carries them on each message.
//   - `mentioned` is set only for `@**Name**` / `@**Name|id**` outside code
//     spans, code blocks and quotes; `@**all**` sets the wildcard flag.
//   - Every user is subscribed to every channel; a DM reaches its
//     participants only.  A sender gets its own message back, as on Zulip.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeZulipUser {
  user_id: number;
  email: string;
  full_name: string;
  is_bot: boolean;
  bot_type?: number | null;
  role: number;
  /** False once deactivated: left out of register's realm_users. */
  is_active?: boolean;
  /** API key; absent for a user that cannot authenticate. */
  key?: string;
}

interface StoredMessage {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  client: string;
  type: "stream" | "private";
  display_recipient: string | Array<{ id: number; email: string; full_name: string }>;
  subject: string;
  content: string;
  timestamp: number;
  /** Per-recipient flags. */
  flags: Map<number, string[]>;
  recipients: number[];
}

interface Queue {
  id: string;
  userId: number;
  events: Array<Record<string, unknown>>;
  nextEventId: number;
  waiters: Set<() => void>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  userId?: number;
}

const CODE_BLOCK = /^(```|~~~)[\s\S]*?(^\1[ \t]*$|(?![\s\S]))/gm;
const CODE_SPAN = /`[^`\n]*`/g;
const QUOTE_LINE = /^\s*>.*$/gm;

function visible(content: string): string {
  return content.replace(CODE_BLOCK, "").replace(CODE_SPAN, "").replace(QUOTE_LINE, "");
}

export class FakeZulip {
  readonly users = new Map<number, FakeZulipUser>();
  readonly messages: StoredMessage[] = [];
  readonly requests: RecordedRequest[] = [];
  private readonly queues = new Map<string, Queue>();
  private server?: Server;
  private nextMessageId = 1000;
  private nextQueue = 1;
  private rateLimits: Array<{ path: string; retryAfter: number }> = [];
  private failures: Array<{ method: string; path: string; status: number }> = [];
  heartbeatMs = 150;
  url = "";
  /** Seconds since the epoch for the next message; tests move it. */
  clock = Math.floor(Date.now() / 1000);

  addUser(user: Partial<FakeZulipUser> & Pick<FakeZulipUser, "user_id" | "full_name">): FakeZulipUser {
    const full: FakeZulipUser = {
      email: `${user.full_name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@zulip.test`,
      is_bot: true,
      role: 400,
      bot_type: user.is_bot === false ? null : 1,
      ...user,
    };
    this.users.set(full.user_id, full);
    return full;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP host:port reports an AddressInfo.
    const address = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const queue of this.queues.values()) for (const wake of queue.waiters) wake();
    this.server?.closeAllConnections?.();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** The next request to `path` answers 429 with this Retry-After. */
  rateLimitNext(path: string, retryAfter = 0): void {
    this.rateLimits.push({ path, retryAfter });
  }

  /** The next `times` `method` requests to `path` answer this HTTP error. */
  failNext(path: string, status = 500, times = 1, method = "GET"): void {
    for (let n = 0; n < times; n++) this.failures.push({ method, path, status });
  }

  /** Drop every queue (all users, or one): the next poll gets BAD_EVENT_QUEUE_ID. */
  expireQueues(userId?: number): void {
    for (const [id, queue] of this.queues) {
      if (userId === undefined || queue.userId === userId) {
        this.queues.delete(id);
        for (const wake of queue.waiters) wake();
      }
    }
  }

  /** Deactivate a user: register stops listing it, and every queue gets a
   *  realm_user update saying so, as on Zulip. */
  deactivate(userId: number): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`no user ${userId}`);
    user.is_active = false;
    this.pushToAll({ type: "realm_user", op: "update", person: { user_id: userId, is_active: false } });
  }

  /** Push one event to every live queue (or one user's). */
  private pushToAll(event: Record<string, unknown>, userId?: number): void {
    for (const queue of this.queues.values()) {
      if (userId !== undefined && queue.userId !== userId) continue;
      queue.events.push({ id: queue.nextEventId++, ...event });
      for (const wake of queue.waiters) wake();
    }
  }

  queueCount(userId?: number): number {
    return [...this.queues.values()].filter((queue) => userId === undefined || queue.userId === userId).length;
  }

  get maxMessageId(): number {
    return this.messages.length ? this.messages[this.messages.length - 1]!.id : 0;
  }

  /** A channel message.  Returns its id. */
  postStream(senderId: number, channel: string, topic: string, content: string, client = "website"): number {
    return this.store(senderId, { channel, topic }, content, client);
  }

  /** A direct message to `to` (user ids, not including the sender). */
  postDm(senderId: number, to: number[], content: string, client = "website"): number {
    return this.store(senderId, { dm: to }, content, client);
  }

  /** Messages a given user posted, newest last. */
  postsBy(userId: number): StoredMessage[] {
    return this.messages.filter((message) => message.sender_id === userId);
  }

  private store(
    senderId: number,
    where: { channel: string; topic: string } | { dm: number[] },
    content: string,
    client: string,
  ): number {
    const sender = this.users.get(senderId);
    if (!sender) throw new Error(`no user ${senderId}`);
    const id = ++this.nextMessageId;
    const recipients = "dm" in where ? [...new Set([senderId, ...where.dm])] : [...this.users.keys()];
    const shown = visible(content);
    const flags = new Map<number, string[]>();
    for (const userId of recipients) {
      const user = this.users.get(userId)!;
      const own: string[] = userId === senderId ? ["read"] : [];
      if (shown.includes(`@**${user.full_name}**`) || shown.includes(`@**${user.full_name}|${user.user_id}**`)) {
        own.push("mentioned");
      }
      if (!("dm" in where) && /@\*\*(all|everyone|channel|stream)\*\*/.test(shown)) own.push("stream_wildcard_mentioned");
      flags.set(userId, own);
    }
    const message: StoredMessage = {
      id,
      sender_id: senderId,
      sender_email: sender.email,
      sender_full_name: sender.full_name,
      client,
      type: "dm" in where ? "private" : "stream",
      display_recipient:
        "dm" in where
          ? recipients.map((userId) => {
              const user = this.users.get(userId)!;
              return { id: user.user_id, email: user.email, full_name: user.full_name };
            })
          : where.channel,
      subject: "dm" in where ? "" : where.topic,
      content,
      timestamp: this.clock,
      flags,
      recipients,
    };
    this.messages.push(message);
    for (const queue of this.queues.values()) {
      if (!recipients.includes(queue.userId)) continue;
      queue.events.push({ id: queue.nextEventId++, type: "message", message: this.wire(message), flags: flags.get(queue.userId) ?? [] });
      for (const wake of queue.waiters) wake();
    }
    return id;
  }

  /** A message as GET /messages returns it to one user: with that user's
   *  flags on the message itself. */
  private wireFor(message: StoredMessage, forUser: number) {
    return { ...this.wire(message), flags: message.flags.get(forUser) ?? [] };
  }

  /** A message as the events API carries it: flags live on the event. */
  private wire(message: StoredMessage) {
    return {
      id: message.id,
      sender_id: message.sender_id,
      sender_email: message.sender_email,
      sender_full_name: message.sender_full_name,
      client: message.client,
      type: message.type,
      display_recipient: message.display_recipient,
      subject: message.subject,
      content: message.content,
      timestamp: message.timestamp,
    };
  }

  private auth(req: IncomingMessage): FakeZulipUser | undefined {
    const header = req.headers.authorization ?? "";
    const match = /^Basic (.+)$/.exec(header);
    if (!match) return undefined;
    const [email, key] = Buffer.from(match[1]!, "base64").toString("utf8").split(":");
    return [...this.users.values()].find((user) => user.email === email && user.key !== undefined && user.key === key);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    let body = "";
    for await (const chunk of req) body += chunk;
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    for (const [k, v] of new URLSearchParams(body)) params[k] = v;
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const send = (status: number, payload: Record<string, unknown>, headers: Record<string, string> = {}) => {
      if (res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const user = this.auth(req);
    this.requests.push({ method: req.method ?? "GET", path, params, userId: user?.user_id });
    if (!user) return send(401, { result: "error", msg: "Invalid API key", code: "UNAUTHORIZED" });
    const limit = this.rateLimits.findIndex((entry) => entry.path === path);
    if (limit >= 0) {
      const [entry] = this.rateLimits.splice(limit, 1);
      return send(429, { result: "error", msg: "API usage exceeded rate limit", code: "RATE_LIMIT_HIT", "retry-after": entry!.retryAfter }, { "retry-after": String(entry!.retryAfter) });
    }

    const failure = this.failures.findIndex((entry) => entry.path === path && entry.method === req.method);
    if (failure >= 0) {
      const [entry] = this.failures.splice(failure, 1);
      return send(entry!.status, { result: "error", msg: "Internal Server Error", code: "BAD_REQUEST" });
    }

    if (req.method === "GET" && path === "users/me") {
      return send(200, {
        result: "success",
        user_id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        is_bot: user.is_bot,
        role: user.role,
        is_admin: user.role === 100 || user.role === 200,
        is_owner: user.role === 100,
      });
    }
    if (req.method === "POST" && path === "register") {
      const id = `q${this.nextQueue++}`;
      this.queues.set(id, { id, userId: user.user_id, events: [], nextEventId: 0, waiters: new Set() });
      return send(200, {
        result: "success",
        queue_id: id,
        last_event_id: -1,
        max_message_id: this.maxMessageId,
        realm_users: [...this.users.values()]
          .filter((entry) => entry.is_active !== false)
          .map(({ key: _key, is_active: _active, ...rest }) => rest),
      });
    }
    if (req.method === "GET" && path === "events") {
      const queue = this.queues.get(params.queue_id ?? "");
      if (!queue || queue.userId !== user.user_id) {
        return send(400, { result: "error", msg: `Bad event queue ID: ${params.queue_id}`, code: "BAD_EVENT_QUEUE_ID", queue_id: params.queue_id });
      }
      const last = Number(params.last_event_id ?? -1);
      queue.events = queue.events.filter((event) => Number(event.id) > last);
      if (!queue.events.length) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            queue.waiters.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, this.heartbeatMs);
          queue.waiters.add(wake);
          req.once("close", wake);
          res.once("close", wake);
        });
        if (!this.queues.has(queue.id)) {
          return send(400, { result: "error", msg: "Bad event queue ID", code: "BAD_EVENT_QUEUE_ID" });
        }
        if (!queue.events.length) queue.events.push({ id: queue.nextEventId++, type: "heartbeat" });
      }
      return send(200, { result: "success", events: queue.events });
    }
    if (req.method === "DELETE" && path === "events") {
      this.queues.delete(params.queue_id ?? "");
      return send(200, { result: "success" });
    }
    if (req.method === "GET" && path === "messages") {
      const narrow: Array<{ operator: string; operand: string | number }> = params.narrow ? JSON.parse(params.narrow) : [];
      const anchor = Number(params.anchor);
      const after = Number(params.num_after ?? 0);
      const include = params.include_anchor === "true";
      const found = this.messages
        .filter((message) => message.recipients.includes(user.user_id))
        .filter((message) => (include ? message.id >= anchor : message.id > anchor))
        .filter((message) =>
          narrow.every((term) => {
            if (term.operator === "is" && term.operand === "dm") return message.type === "private";
            if (term.operator === "is" && term.operand === "mentioned") {
              return (message.flags.get(user.user_id) ?? []).some((flag) => flag === "mentioned" || flag.endsWith("wildcard_mentioned"));
            }
            if (term.operator === "sender") return message.sender_id === Number(term.operand);
            return true;
          }),
        )
        .slice(0, after)
        .map((message) => this.wireFor(message, user.user_id));
      return send(200, { result: "success", messages: found });
    }
    if (req.method === "POST" && path === "messages") {
      const content = params.content ?? "";
      if (!content.trim()) return send(400, { result: "error", msg: "Message must not be empty", code: "BAD_REQUEST" });
      if (params.type === "stream" || params.type === "channel") {
        if (!params.topic) return send(400, { result: "error", msg: "Missing topic", code: "BAD_REQUEST" });
        const id = this.postStream(user.user_id, params.to ?? "", params.topic, content, "BotFleet-Zulip");
        return send(200, { result: "success", id });
      }
      const raw = params.to ?? "";
      const ids: number[] = raw.startsWith("[") ? JSON.parse(raw).map(Number) : [Number(raw)];
      const id = this.postDm(user.user_id, ids, content, "BotFleet-Zulip");
      return send(200, { result: "success", id });
    }
    return send(404, { result: "error", msg: `no fake for ${req.method} ${path}`, code: "BAD_REQUEST" });
  }
}
