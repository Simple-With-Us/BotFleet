// Roster organization through the real proxy, in front of a stand-in harness.
//
// The allowlist tests in routes.test.ts prove the decision functions.  These
// prove the seam: that a body the phone is not allowed to send never reaches
// the harness at all, that an allowed one arrives as the re-serialized object
// the sidecar validated, and that the verbs this batch opened (delete a bot or
// a room, apply model defaults, the automatic update preference) arrive with
// the right method and path.  The stand-in records every request, so "nothing
// reached the harness" is a fact the test reads rather than infers.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { JsonObject } from "../src/json.ts";
import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "omb_organize_token";

interface Seen {
  method: string;
  url: string;
  body: string;
  companion: string | undefined;
  authorization: string | undefined;
}

let seen: Seen[] = [];
let harness: Server;
let sidecar: Server;
let base = "";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

const readAll = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

beforeAll(async () => {
  harness = createServer(async (req, res) => {
    seen.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body: await readAll(req),
      companion: req.headers["x-botfleet-companion"] as string | undefined,
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, bot: { id: "b1" } }));
  });
  const harnessPort = await listen(harness);
  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (token) => (token === TOKEN ? { id: "d1", cloudDesktopAccess: false } : null),
      redeem: () => ({ error: "not pairing" }),
      serverName: () => "Test computer",
    }),
  );
  base = `http://127.0.0.1:${await listen(sidecar)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => sidecar.close(() => resolve()));
  await new Promise<void>((resolve) => harness.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const refusalBody = z.object({ error: z.string() });

const phone = async (
  method: string,
  path: string,
  body?: JsonObject,
  opts: { token?: string | null; raw?: string } = {},
) => {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const headers: Record<string, string> = {};
  if (body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  // Narrowed rather than asserted: the sentence a refusal carries, if any.
  const refusal = refusalBody.safeParse(parsed);
  return { status: res.status, body: parsed, error: refusal.success ? refusal.data.error : undefined };
};

describe("the bot PATCH, narrowed to roster organization", () => {
  it("forwards each organize field to the harness as the validated object", async () => {
    const bodies: JsonObject[] = [
      { hidden: true },
      { hidden: false },
      { pinned: true },
      { unread: true },
      { chiefOfStaff: true },
      { section: "Work" },
      { section: null },
      { pinnedMessageId: "msg_9" },
      { pinnedMessageId: null },
      { hidden: true, chiefOfStaff: false },
    ];
    for (const body of bodies) {
      seen = [];
      const res = await phone("PATCH", "/api/bots/b1", body);
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe("PATCH");
      expect(seen[0]!.url).toBe("/api/bots/b1");
      expect(JSON.parse(seen[0]!.body)).toEqual(body);
      // the harness learns this came from a paired phone, and never sees the
      // device's own credential
      expect(seen[0]!.companion).toBe("1");
      expect(seen[0]!.authorization).toBeUndefined();
    }
  });

  it("cannot set any other bot field, alone or beside an organize field", async () => {
    // Every key server/index.ts reads in its bot PATCH handler that is not an
    // organize field.  A 403 and an empty harness log, for each.
    const fields = [
      "autoApprove",
      "bypassPermissions",
      "alwaysAllow",
      "computers",
      "computer",
      "cwd",
      "composio",
      "cloudBackend",
      "autoStartVps",
      "gitWorktreeLeases",
      "autoReview",
      "approvePeerComms",
      "acknowledgeLocalAuto",
      "color",
      "mascotExpression",
      "name",
      "title",
      "description",
      "avatarUrl",
      "modelSelection",
      "requireAvailableModel",
      "playbooks",
      "off",
      "notifications",
      "voice",
      "futurePrivilege",
    ];
    for (const field of fields) {
      for (const body of [{ [field]: true }, { pinned: true, [field]: "x" }, { [field]: { nested: ["x"] } }]) {
        const res = await phone("PATCH", "/api/bots/b1", body);
        expect(res.status, `${field}: ${JSON.stringify(body)}`).toBe(403);
        expect(res.error).toBe(`${field} can only be changed in BotFleet on your computer`);
      }
    }
    expect(seen).toEqual([]);
  });

  it("refuses wrongly typed values before the harness would store them as sent", async () => {
    const bodies: JsonObject[] = [
      { pinned: "yes" },
      { hidden: 1 },
      { unread: null },
      { chiefOfStaff: "true" },
      { section: 4 },
      { pinnedMessageId: "../../etc" },
      {},
    ];
    for (const body of bodies) {
      const res = await phone("PATCH", "/api/bots/b1", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("rejects bodies that are not a JSON object", async () => {
    for (const raw of ['"pinned"', "[true]", "{not json", "42"]) {
      const res = await phone("PATCH", "/api/bots/b1", undefined, { raw });
      expect(res.status, raw).toBe(400);
    }
    expect(seen).toEqual([]);
  });

  it("forwards the parsed object, so a duplicate key cannot carry a second value past the check", async () => {
    // JSON.parse keeps the last value, and the sidecar re-serializes what it
    // validated, so the harness never sees the first `pinned`.
    const res = await phone("PATCH", "/api/bots/b1", undefined, { raw: '{"pinned":true,"pinned":false}' });
    expect(res.status).toBe(200);
    expect(seen[0]!.body).toBe('{"pinned":false}');
  });

  it("still refuses an unpaired device before reading the body", async () => {
    const res = await phone("PATCH", "/api/bots/b1", { pinned: true }, { token: null });
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });
});

describe("the verbs this batch opened", () => {
  it("deletes a bot and a room, with nothing in the body", async () => {
    expect((await phone("DELETE", "/api/bots/b1")).status).toBe(200);
    expect((await phone("DELETE", "/api/groups/room-1")).status).toBe(200);
    expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "DELETE /api/bots/b1",
      "DELETE /api/groups/room-1",
    ]);
  });

  it("does not let DELETE reach anything nested under a bot or a room", async () => {
    for (const path of ["/api/bots/b1/messages", "/api/bots/b1/profile", "/api/groups/room-1/messages", "/api/bots"]) {
      const res = await phone("DELETE", path);
      expect(res.status, path).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it("reaches the room PATCH with a pinned message, as it always could", async () => {
    const res = await phone("PATCH", "/api/groups/room-1", { pinnedMessageId: "msg_4" });
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/groups/room-1" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ pinnedMessageId: "msg_4" });
  });

  it("applies model defaults, and refuses the computer defaults with a sentence", async () => {
    const body = { slots: { primary: { instanceId: "claude", model: "opus" }, fallbacks: [null, null, null] } };
    const ok = await phone("POST", "/api/bots/apply-model-defaults", body);
    expect(ok.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/bots/apply-model-defaults" });
    expect(JSON.parse(seen[0]!.body)).toEqual(body);

    seen = [];
    const computers = await phone("POST", "/api/bots/apply-defaults", { botDefaults: { computers: ["local"] } });
    expect(computers.status).toBe(403);
    expect(computers.error).toBe("computer defaults for every bot are set on your computer");
    expect(seen).toEqual([]);
  });

  it("changes the automatic update preference through its own route, never the config", async () => {
    const ok = await phone("PATCH", "/api/auto-update", { enabled: true });
    expect(ok.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "PATCH", url: "/api/auto-update" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ enabled: true });

    seen = [];
    const config = await phone("PUT", "/api/config", { autoUpdate: { enabled: true } });
    expect(config.status).toBe(403);
    expect(seen).toEqual([]);
  });
});
