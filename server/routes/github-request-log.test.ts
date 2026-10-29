import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createRequestLog } from "../request-log.ts";
import { readGitHubRequestLog } from "./github-request-log.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grl-route-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SECRET = "test-hook-secret";

function fixture(body: string, headers: Record<string, string>) {
  // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
  const req = Readable.from([Buffer.from(body)]) as Readable & { headers: Record<string, string> };
  req.headers = headers;
  let status = 0;
  let responseBody = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(text?: string) {
      responseBody = text ?? "";
      return this;
    },
  };
  return { req, res, result: () => ({ status, body: responseBody }) };
}

function signed(body: string, extra: Record<string, string> = {}) {
  return {
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    "x-github-event": "pull_request",
    "x-github-delivery": "delivery-abc",
    ...extra,
  };
}

function setup(dir: string) {
  const log = createRequestLog({
    filePath: join(dir, "github-request-log.md"),
    spoolPath: join(dir, "github-request-log.spool"),
    cursorPath: join(dir, "github-request-log.cursor"),
  });
  return {
    log,
    options: {
      requestLog: log,
      secretProvider: () => SECRET,
      webhookName: "github-org-hook",
      beginAdmission: () => () => undefined,
    },
  };
}

const PAYLOAD = JSON.stringify({
  action: "opened",
  repository: { full_name: "Simple-With-Us/BotFleet" },
  pull_request: { number: 1320, title: "title text must not leak" },
  sender: { login: "swu-echo[bot]" },
});

describe("readGitHubRequestLog", () => {
  it("records a metadata-only line for a correctly signed delivery", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD));
    // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
    await readGitHubRequestLog(req as never, res as never, options);
    expect(result().status).toBe(200);
    const line = readFileSync(join(dir, "github-request-log.md"), "utf8").trim();
    expect(line).toContain("pull_request.opened");
    expect(line).toContain("Simple-With-Us/BotFleet#1320");
    expect(line).toContain("by swu-echo[bot]");
    expect(line).toContain("[received]");
    expect(line).toContain("(delivery delivery-abc)");
    expect(line).not.toContain("title text must not leak");
  });

  it("rejects a bad signature with 401 and writes nothing", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD, { "x-hub-signature-256": "sha256=deadbeef" }));
    // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
    await readGitHubRequestLog(req as never, res as never, options);
    expect(result().status).toBe(401);
    expect(() => readFileSync(join(dir, "github-request-log.md"), "utf8")).toThrow();
  });

  it("fails closed with 503 when no secret is configured", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD));
    // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
    await readGitHubRequestLog(req as never, res as never, { ...options, secretProvider: () => undefined });
    expect(result().status).toBe(503);
  });

  it("rejects malformed JSON with 400 after authentication", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const body = "not json";
    const { req, res, result } = fixture(body, signed(body));
    // SAFETY: this test double implements only the fields consumed by the subject; unrelated members are never read.
    await readGitHubRequestLog(req as never, res as never, options);
    expect(result().status).toBe(400);
  });
});

it("acknowledges durable inbox admission during shared writer contention", async () => {
  const dir = tmp();
  const { options } = setup(dir);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "github-request-log.md.lock"));
  const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD));
  // SAFETY: HTTP doubles implement the fields consumed by the route.
  await readGitHubRequestLog(req as never, res as never, options);
  expect(result().status).toBe(200);
  const { readdirSync, rmSync } = await import("node:fs");
  const inbox = join(dir, "github-request-log.spool.pending");
  expect(readdirSync(inbox)).toHaveLength(1);
  rmSync(join(dir, "github-request-log.md.lock"), { recursive: true });
  options.requestLog.replay(); options.requestLog.replay();
  expect(readFileSync(join(dir, "github-request-log.md"), "utf8").trim().split("\n")).toHaveLength(1);
});
it("records authenticated malformed JSON metadata before returning 400", async () => {
  const dir = tmp();
  const { options } = setup(dir);
  const body = "not json";
  const { req, res, result } = fixture(body, signed(body));
  // SAFETY: HTTP doubles implement the fields consumed by the route.
  await readGitHubRequestLog(req as never, res as never, options);
  expect(result().status).toBe(400);
  const log = readFileSync(join(dir, "github-request-log.md"), "utf8");
  expect(log).toContain("[invalid_json]");
  expect(log).not.toContain(body);
});
it("rejects missing delivery identity rather than inventing one", async () => {
  const dir = tmp();
  const { options } = setup(dir);
  const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD, { "x-github-delivery": "" }));
  // SAFETY: HTTP doubles implement the fields consumed by the route.
  await readGitHubRequestLog(req as never, res as never, options);
  expect(result().status).toBe(400);
});
it("rejects same-character-count non-ASCII signatures without throwing", async () => {
  const dir = tmp();
  const { options } = setup(dir);
  const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD, { "x-hub-signature-256": "sha256=" + "é".repeat(64) }));
  // SAFETY: HTTP doubles implement the fields consumed by the route.
  await readGitHubRequestLog(req as never, res as never, options);
  expect(result().status).toBe(401);
});

it.each(["null", "[]", "42", '"text"'])("rejects authenticated non-object payload %s with a metadata-only receipt", async (body) => {
  const dir = tmp(); const { options } = setup(dir);
  const { req, res, result } = fixture(body, signed(body));
  // SAFETY: HTTP doubles implement the fields consumed by the route.
  await readGitHubRequestLog(req as never, res as never, options);
  expect(result().status).toBe(400); expect(result().body).toContain("bad_payload");
  expect(readFileSync(join(dir, "github-request-log.md"), "utf8")).toContain("[invalid_payload]");
});
