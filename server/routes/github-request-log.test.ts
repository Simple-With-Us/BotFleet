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
    await readGitHubRequestLog(req as never, res as never, options);
    expect(result().status).toBe(401);
    expect(() => readFileSync(join(dir, "github-request-log.md"), "utf8")).toThrow();
  });

  it("fails closed with 503 when no secret is configured", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const { req, res, result } = fixture(PAYLOAD, signed(PAYLOAD));
    await readGitHubRequestLog(req as never, res as never, { ...options, secretProvider: () => undefined });
    expect(result().status).toBe(503);
  });

  it("rejects malformed JSON with 400 after authentication", async () => {
    const dir = tmp();
    const { options } = setup(dir);
    const body = "not json";
    const { req, res, result } = fixture(body, signed(body));
    await readGitHubRequestLog(req as never, res as never, options);
    expect(result().status).toBe(400);
  });
});
