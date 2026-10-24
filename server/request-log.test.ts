import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createRequestLogWriter, extractRequestMetadata, formatRequestLogLine } from "./request-log.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-request-log-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const attempt = {
  id: "attempt-1",
  deliveryId: "deliv-1",
  webhookId: "wh-1",
  eventName: "pull_request",
  receivedAt: new Date("2026-10-24T06:40:00.000Z").getTime(),
  outcome: "accepted",
  statusCode: 200,
  preview: "",
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
    const line = formatRequestLogLine(attempt as never, meta, "AFC");
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
      attempt as never,
      { action: "opened", repository: "Simple-With-Us/AI-Fleet-Coordinator", number: 885, actor: "swu-echo[bot]" },
      "AFC hooks",
    );
    expect(line).toBe(
      "- 2026-10-24T06:40:00Z pull_request.opened Simple-With-Us/AI-Fleet-Coordinator#885 by swu-echo[bot] [accepted] via AFC hooks (delivery deliv-1)",
    );
  });
});

describe("createRequestLogWriter", () => {
  it("appends one durable line per attempt event and ignores other events", () => {
    const filePath = join(tmp(), "github-request-log.md");
    const write = createRequestLogWriter({ filePath });
    write({
      kind: "webhook.attempt",
      attempt: attempt as never,
      requestMetadata: { repository: "o/r", number: 1, actor: "bot", action: "opened" },
    });
    write({
      kind: "webhook.attempt",
      attempt: { ...attempt, id: "attempt-2", outcome: "ignored", reason: "Event type not enabled" } as never,
    });
    write({ kind: "webhook", webhook: {} as never });
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[accepted]");
    expect(lines[0]).toContain("o/r#1");
    expect(lines[1]).toContain("[ignored]");
    expect(lines[1]).toContain("Event type not enabled");
  });

  it("never throws into dispatch, even when the log path is unwritable", () => {
    const dir = tmp();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const write = createRequestLogWriter({ filePath: join(blocker, "log.md") });
    expect(() => write({ kind: "webhook.attempt", attempt: attempt as never })).not.toThrow();
  });
});
