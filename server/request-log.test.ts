import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRequestLog,
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
      attempt: { ...entry, id: "attempt-2", deliveryId: "deliv-2", outcome: "ignored", reason: "Event type not enabled", statusCode: 200, preview: "" } as never,
    });
    log.subscriber({ kind: "webhook", webhook: {} as never });
    const lines = readFileSync(join(dirs.at(-1)!, "github-request-log.md"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[accepted]");
    expect(lines[0]).toContain("o/r#1");
    expect(lines[1]).toContain("[ignored]");
    expect(lines[1]).toContain("Event type not enabled");
  });

  it("spool survives an unwritable Markdown path and replay drains it after recovery", () => {
    const dir = tmp();
    const p = paths(dir);
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    const errors: string[] = [];
    const log = createRequestLog({ ...p, filePath: join(blocker, "log.md"), onError: (m) => errors.push(m) });
    log.record(entry, { repository: "o/r", number: 7, actor: "kody-ai[bot]", action: "submitted" });
    expect(errors.length).toBeGreaterThan(0);
    // The spool holds the record even though the Markdown write failed.
    expect(readFileSync(p.spoolPath, "utf8")).toContain("deliv-1");

    rmSync(blocker);
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
