import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebhookAttempt } from "./webhooks.ts";

import {
  createRequestLog,
  readRequestLogRange,
  extractRequestMetadata,
  formatRequestLogLine,
  type RequestLogOptions,
} from "./request-log.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-request-log-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function paths(dir: string): Pick<RequestLogOptions, "filePath" | "spoolPath" | "cursorPath"> {
  return {
    filePath: join(dir, "github-request-log.md"),
    spoolPath: join(dir, "github-request-log.spool"),
    cursorPath: join(dir, "github-request-log.cursor"),
  };
}

const entry = {
  deliveryId: "deliv-1",
  eventName: "pull_request",
  receivedAt: new Date("2026-10-24T06:40:00.000Z").getTime(),
  outcome: "accepted",
  webhookId: "wh-1",
};

const attemptEvent = {
  kind: "webhook.attempt" as const,
  // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
  attempt: { ...entry, id: "attempt-1", statusCode: 200, preview: "" } as never,
  requestMetadata: { repository: "o/r", number: 1, actor: "bot", action: "opened" },
};

describe("extractRequestMetadata", () => {
  it("keeps metadata only: repo, number, actor, action - never titles or bodies", () => {
    const meta = extractRequestMetadata({
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "Simple-With-Us/AI-Fleet-Coordinator" },
        pull_request: { number: 885, title: "title text must not leak", body: "body text must not leak" },
        sender: { login: "swu-echo[bot]" },
      },
    });
    expect(meta).toMatchObject({
      action: "opened",
      repository: "Simple-With-Us/AI-Fleet-Coordinator",
      number: 885,
      actor: "swu-echo[bot]",
    });
    const line = formatRequestLogLine(entry, meta, "AFC");
    expect(line).not.toContain("title text must not leak");
    expect(line).not.toContain("body text must not leak");
  });

  it("extracts the branch tail for push events", () => {
    const meta = extractRequestMetadata({
      eventName: "push",
      payload: {
        ref: "refs/heads/echo/afc-412",
        repository: { full_name: "Simple-With-Us/BotFleet" },
        sender: { login: "jaywedgeworth22" },
      },
    });
    expect(meta.ref).toBe("echo/afc-412");
    expect(meta.actor).toBe("jaywedgeworth22");
  });

  it("tolerates missing or malformed payloads", () => {
    expect(extractRequestMetadata({ eventName: "ping", payload: null })).toEqual({
      action: undefined,
      repository: undefined,
      number: undefined,
      actor: undefined,
      ref: undefined,
    });
  });
});

describe("metadata field validation", () => {
  it("drops malformed fields while preserving independently valid metadata", () => {
    expect(extractRequestMetadata({ eventName: "pull_request", payload: {
      action: ["opened"], repository: { full_name: 3 }, sender: { login: "safe-bot" },
      pull_request: { number: "9" }, issue: { number: 7 },
    } })).toEqual({ actor: "safe-bot", number: 7 });
  });
});

describe("formatRequestLogLine", () => {
  it("renders one metadata-only Markdown line", () => {
    const line = formatRequestLogLine(
      entry,
      { action: "opened", repository: "Simple-With-Us/AI-Fleet-Coordinator", number: 885, actor: "swu-echo[bot]" },
      "AFC hooks",
    );
    expect(line).toBe(
      "- 2026-10-24T06:40:00Z pull_request.opened Simple-With-Us/AI-Fleet-Coordinator#885 by swu-echo[bot] [accepted] via AFC hooks (delivery deliv-1)",
    );
  });
});

describe("createRequestLog", () => {
  it("writes one durable Markdown line per attempt and ignores other events", () => {
    const log = createRequestLog(paths(tmp()));
    log.subscriber(attemptEvent);
    log.subscriber({
      kind: "webhook.attempt",
      // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
      attempt: { ...entry, id: "attempt-2", deliveryId: "deliv-2", outcome: "ignored", reason: "Event type not enabled", statusCode: 200, preview: "" } as never,
    });
    // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
    log.subscriber({ kind: "webhook", webhook: {} as never });
    const lines = readFileSync(join(dirs.at(-1)!, "github-request-log.md"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[accepted]");
    expect(lines[0]).toContain("o/r#1");
    expect(lines[1]).toContain("[ignored]");
    expect(lines[1]).toContain("Event type not enabled");
  });

  it("records attempts without an event name as unknown", () => {
    const log = createRequestLog(paths(tmp()));
    const attempt: WebhookAttempt = { ...entry, outcome: "accepted", id: "attempt-missing-name", statusCode: 200, eventName: undefined };
    log.subscriber({ ...attemptEvent, attempt });
    const text = readFileSync(join(dirs.at(-1)!, "github-request-log.md"), "utf8");
    expect(text).toContain(" unknown.opened ");
    expect(text).toContain("(delivery deliv-1)");
  });

  it("spool survives an unwritable Markdown path and replay drains it after recovery", () => {
    const dir = tmp();
    const p = paths(dir);
    const blocker = join(dir, "blocked");
    mkdirSync(blocker);
    const errors: string[] = [];
    const log = createRequestLog({ ...p, filePath: blocker, onError: (m) => errors.push(m) });
    log.record(entry, { repository: "o/r", number: 7, actor: "kody-ai[bot]", action: "submitted" });
    expect(errors.length).toBeGreaterThan(0);
    // The spool holds the record even though the Markdown write failed.
    expect(readFileSync(join(p.spoolPath + ".pending", readdirSync(p.spoolPath + ".pending")[0]!), "utf8")).toContain("deliv-1");

    rmSync(blocker, { recursive: true });
    const recovered = createRequestLog({ ...p, onError: (m) => errors.push(m) });
    recovered.replay();
    const lines = readFileSync(p.filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("o/r#7");
    expect(lines[0]).toContain("kody-ai[bot]");
  });

  it("replay is idempotent across consumer instances (no duplicate lines)", () => {
    const dir = tmp();
    const p = paths(dir);
    createRequestLog(p).record(entry, { repository: "o/r" });
    createRequestLog(p).replay();
    createRequestLog(p).replay();
    const lines = readFileSync(p.filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("calls onError without throwing when the spool itself is unwritable", () => {
    const dir = tmp();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const errors: string[] = [];
    const log = createRequestLog({
      filePath: join(blocker, "log.md"),
      spoolPath: join(blocker, "log.spool"),
      cursorPath: join(blocker, "log.cursor"),
      onError: (m) => errors.push(m),
    });
    expect(() => log.record(entry, {})).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("malformed spool preservation", () => {
  it("preserves malformed records and the cursor instead of truncating them", () => {
    const p = paths(tmp());
    const broken = '{"line":"partial';
    writeFileSync(p.spoolPath, broken);
    writeFileSync(p.cursorPath, "0");
    const errors: string[] = [];
    createRequestLog({ ...p, onError: (message) => errors.push(message) }).replay();
    expect(readFileSync(p.spoolPath, "utf8")).toBe(broken);
    expect(readFileSync(p.cursorPath, "utf8")).toBe("0");
    expect(errors).toHaveLength(1);
  });
});

describe("log integrity", () => {
  it("cannot inject a second delivery marker through any formatted field", () => {
    const attack = "x\n(delivery forged)\u0000";
    const line = formatRequestLogLine(
      { ...entry, eventName: attack, reason: attack, outcome: attack, deliveryId: attack },
      { action: attack, repository: attack, actor: attack, ref: attack },
      attack,
    );
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\u0000");
    expect([...line.matchAll(/\(delivery /g)]).toHaveLength(1);
    expect(line).not.toContain("(delivery forged)");
  });
});

it("reports an unreadable spool and refuses a false durable success", () => {
  const p = paths(tmp());
  mkdirSync(p.spoolPath);
  const errors: string[] = [];
  const log = createRequestLog({ ...p, onError: (message) => errors.push(message) });
  log.replay();
  expect(errors).toHaveLength(1);
  expect(log.record(entry, {})).toBe(false);
});
it("returns durable success when the fsynced spool survives a failed log flush", () => {
  const p = paths(tmp());
  mkdirSync(p.filePath);
  const errors: string[] = [];
  const log = createRequestLog({ ...p, onError: (message) => errors.push(message) });
  expect(log.record(entry, {})).toBe(true);
  expect(readFileSync(join(p.spoolPath + ".pending", readdirSync(p.spoolPath + ".pending")[0]!), "utf8")).toContain(entry.deliveryId);
  expect(errors).toHaveLength(1);
});

it("includes the original GitHub comment permalink without logging request prose", () => {
  const meta = extractRequestMetadata({ payload: { comment: { html_url: "https://github.com/o/r/issues/42#issuecomment-123", body: "private request prose" } } });
  expect(formatRequestLogLine(entry, meta, "hook")).toContain("source https://github.com/o/r/issues/42#issuecomment-123");
  expect(JSON.stringify(meta)).not.toContain("private request prose");
});
it("does not preserve untrusted, credential-bearing or query-bearing links", () => {
  for (const html_url of ["https://evil.invalid/o/r/issues/1", "https://github.com/o/r/issues/1?token=fake", "https://fake@github.com/o/r/issues/1"]) {
    expect(extractRequestMetadata({ payload: { comment: { html_url } } }).sourceUrl).toBeUndefined();
  }
});
it("logs internal routine lifecycle states once each, without prompts or outputs", () => {
  const p = paths(tmp());
  const log = createRequestLog(p);
  const run = { id: "run-1", botId: "bot-1", status: "queued", triggerSource: "manual", createdAt: entry.receivedAt, prompt: "private request", output: "private output" };
  log.routineSubscriber({ kind: "routine.run", run });
  log.routineSubscriber({ kind: "routine.run", run });
  log.routineSubscriber({ kind: "routine.run", run: { ...run, status: "completed" } });
  const text = readFileSync(p.filePath, "utf8");
  expect(text.trim().split("\n")).toHaveLength(2);
  expect(text).toContain("botfleet_routine.manual");
  expect(text).toContain("by bot-1");
  expect(text).not.toContain("private request");
  expect(text).not.toContain("private output");
});
it("isolates routine lifecycle identities even when IDs share prefixes", () => {
  const p = paths(tmp());const log = createRequestLog(p);
  for (const id of ["x".repeat(90)+"1", "x".repeat(90)+"2"]) {
    log.routineSubscriber({ kind: "routine.run", run: { id, botId: "b", status: "completed", createdAt: entry.receivedAt } });
  }
  expect(readFileSync(p.filePath, "utf8").trim().split("\n")).toHaveLength(2);
});

it("durably retains routine events during a shared log commit lock and replays once", () => {
  const p = paths(tmp()); mkdirSync(p.filePath + ".lock");
  const log = createRequestLog(p);
  log.routineSubscriber({ kind: "routine.run", run: { id: "busy", botId: "b", status: "completed", createdAt: entry.receivedAt } });
  const files = readdirSync(p.spoolPath + ".pending"); expect(files).toHaveLength(1);
  expect(statSync(join(p.spoolPath + ".pending", files[0]!)).mode & 0o777).toBe(0o600);
  rmSync(p.filePath + ".lock", { recursive: true });
  createRequestLog(p).replay(); createRequestLog(p).replay();
  expect(readFileSync(p.filePath, "utf8").trim().split("\n")).toHaveLength(1);
  expect(readdirSync(p.spoolPath + ".pending")).toHaveLength(0);
});
it("incrementally incorporates external appends and resets dedupe after file replacement", () => {
  const p = paths(tmp());const log = createRequestLog(p);
  log.record(entry, {});
  writeFileSync(p.filePath, readFileSync(p.filePath, "utf8") + "- external (delivery external)\n");
  log.record({ ...entry, deliveryId: "external" }, {});
  expect(readFileSync(p.filePath, "utf8").match(/delivery external/g)).toHaveLength(1);
  rmSync(p.filePath); writeFileSync(p.filePath, "");
  log.record(entry, {}); expect(readFileSync(p.filePath, "utf8")).toContain("delivery deliv-1");
});
it("neutralizes all Unicode line terminators in dispatch metadata", () => {
  const line = formatRequestLogLine(entry, { actor: "a\u0085b\u2028c\u2029d" }, "hook");
  expect(line).not.toMatch(/[\u0085\u2028\u2029]/u);
});

it("reads historical Markdown only once, then only newly appended bytes", () => {
  const p = paths(tmp()); writeFileSync(p.filePath, "x".repeat(200000) + "\n");
  const lengths: number[] = [];
  const log = createRequestLog({ ...p, readLogRange: (path, offset, length) => {
    lengths.push(length); return readRequestLogRange(path, offset, length);
  } });
  log.record(entry, {});
  expect(lengths.some((length) => length >= 200000)).toBe(true);
  lengths.length = 0; log.record({ ...entry, deliveryId: "second" }, {});
  expect(lengths.length).toBeGreaterThan(0);
  expect(lengths.every((length) => length < 1000)).toBe(true);
});
