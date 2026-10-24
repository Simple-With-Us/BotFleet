// The harness boots under `node --experimental-strip-types` in dev and runs
// pre-bundled `.js` in production -- both paths go through real TypeScript at
// some point, and Node's strip-only mode refuses constructor parameter
// properties (the syntax shortcut `constructor(private readonly foo: T)`
// is a TypeScript-only construct that strip-only cannot lower).  When that
// rejection fires the harness dies at parse time and every route 404s, so a
// status call is the right first smoke.  This test boots the harness the
// same way the `dev:server` script does, hits a real route, and asserts the
// request was actually parsed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StsErrorBodySchema, StsStatusSchema } from "./sts-access.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Both bodies this route answers with live in server/sts-access.ts, exported
// with their inferred types.  A private schema in this file could not carry
// a type, and a second copy would drift from the route.  The assertions
// below used to reach into a bare JSON.parse result, so a route that
// answered 200 with the wrong shape still passed as long as the keys
// happened to be present.  Parsing here fails loudly on drift instead.

function freePort() {
  // Reserve a free port by listening on 0 and capturing the assigned one,
  // then closing the listener.  Avoids a race where the harness's parse
  // finishes after this test already grabbed the port.
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine bound port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

test("the whole harness entry parses under --experimental-strip-types", async () => {
  // The exact regression class from CI run 38444206765: a constructor
  // parameter property in server/sts-access.ts killed the harness at parse
  // time with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.  `node --check` walks the
  // full import graph without executing anything, so this is a <5s gate
  // against the same failure instead of a 60s+ boot.
  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--check", "server/index.ts"],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(
    result.code,
    0,
    `harness entry must parse under strip-types (exit ${result.code}):\n${result.stderr}`,
  );
});

test("the harness boots under --experimental-strip-types and serves /api/sts/status", async (t) => {
  const port = await freePort();
  // The harness also binds a webhook receiver at OMB_WEBHOOK_PORT, defaulting
  // to PORT+1.  Reserving only the main port leaves the webhook on a fixed
  // address a parallel runner may hold, which fails the boot this test is
  // trying to prove.  Reserve both.
  const webhookPort = await freePort();
  const home = mkdtempSync(path.join(tmpdir(), "bf-sts-launch-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Capture stderr so a strip-time parse error (the regression this guards)
  // is visible in the test output rather than failing as a bare timeout.
  let childStderr = "";
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "server/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(webhookPort),
        // Block anything that reaches for a sibling container or the Local VM.
        OMB_LOCAL_VM_DISABLED: "1",
        OMB_LOCAL_VM_CONTAINER_RUNTIME_GUARD: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => {
    childStderr += String(chunk);
  });
  t.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });

  // Wait for the server to answer; this is a real network probe against the
  // freshly-booted harness, which is the only way to catch a strip-time
  // parse error before a CI job gets green and a phone call gets 404s.
  // Full boot takes ~60s locally (engine probes, including a 30s opencode
  // describe timeout) and longer on loaded CI runners -- the 180s budget
  // is deliberate.
  const url = `http://127.0.0.1:${port}/api/sts/status`;
  let response;
  try {
    response = await waitForResponse(url, 180_000);
  } catch (error) {
    throw new Error(`${error.message}\n--- harness stderr ---\n${childStderr || "(empty)"}`);
  }
  // 503 is the documented "I could not read the keys" answer.  200 would
  // mean a key is configured, which is not what the test cares about.  Any
  // other status means the harness parsed and routed, which is the property
  // under test; the body is just the consequence of the host's keyring.
  assert.ok(
    response.status === 200 || response.status === 503,
    `expected 200 or 503, got ${response.status}: ${response.body}`,
  );
  // The response is a real server response, not a connection error: it
  // carries the JSON shape the harness publishes.
  const parsed = JSON.parse(response.body);
  assert.equal(typeof parsed, "object");
  if (response.status === 503) {
    const refused = StsErrorBodySchema.safeParse(parsed);
    assert.ok(
      refused.success,
      `503 from /api/sts/status must be { error: string }, got ${response.body}`,
    );
    assert.match(
      refused.data.error,
      /voice provider keys/,
      "503 from /api/sts/status must say the keys could not be read",
    );
  } else {
    const ready = StsStatusSchema.safeParse(parsed);
    assert.ok(
      ready.success,
      `200 from /api/sts/status must be { xai, gemini, provider }, got ${response.body}`,
    );
  }

  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", () => resolve()));
});

async function waitForResponse(url, timeoutMs) {
  // The harness answers 503 { error: "booting" } while its async boot is
  // still in flight (server/index.ts handleBootRequest).  That is a sign of
  // a live, parseable process, not of the route working -- keep waiting until
  // the real handler takes over.
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: "GET" });
      const body = await response.text();
      if (response.status > 0 && !(response.status === 503 && body.includes("booting"))) {
        return { status: response.status, body };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`harness did not respond at ${url} in ${timeoutMs}ms: ${String(lastError)}`);
}
