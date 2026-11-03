import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request, createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOwnerGate } from "../deploy/linux-server/owner-gate.mjs";
import { WORKER_INTENTS } from "../shared/placement-worker-http.mjs";
import { type HostId } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";
import { WorkerAuthorizationSchema, createWorkerRequestBoundary, privateWorkerAuthorizationSource, workerVerifier, type WorkerAuthorization } from "./placement-worker-auth.ts";
import { spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const audience: HostId = "server:11111111-1111-4111-8111-111111111111";
const worker: HostId = "mac:22222222-2222-4222-8222-222222222222";
const other: HostId = "server:33333333-3333-4333-8333-333333333333";
interface FixtureEnvelope { authVersion: string; hostId: HostId; audience: HostId; role: string; executionReceiptVersion?: string; capabilities?: string[] }
const envelope: FixtureEnvelope = { authVersion: "1", hostId: worker, audience, role: "execution-worker" };
const dirs: string[] = [];
const servers: Server[] = [];
function fixture() { const dir = mkdtempSync(join(tmpdir(), "bf-worker-auth-")); dirs.push(dir); return dir; }
function credential() {
  const credentialId = randomUUID();
  const secret = randomBytes(32).toString("hex");
  const record: WorkerAuthorization = { format: "botfleet-placement-worker", version: 1, credentialId, revision: 1, hostId: worker, audience, role: "execution-worker", secretSha256: createHash("sha256").update(secret).digest("hex"), revoked: false, expiresAt: null };
  return { credentialId, secret, record, authorization: `BotFleet-Worker bfw1.${credentialId}.${secret}` };
}
function save(dir: string, record: WorkerAuthorization) {
  const parent = join(dir, "placement-worker-authorizations");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, `${record.credentialId}.json`);
  writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, exactMode: true });
  return path;
}
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return z.object({ port: z.number().int().positive() }).parse(server.address()).port;
}
async function send(port: number, authorization: string, path = "/api/placement/worker/register", body = envelope, method = "POST", extra: Record<string, string | undefined> = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { authorization, "content-type": "application/json", ...extra }, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => {
        const headers = new Headers();
        for (const [key, values] of Object.entries(res.headers)) for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) headers.append(key, value);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on("error", reject); req.end(method === "GET" ? undefined : JSON.stringify(body));
  });
}
function raw(port: number, headers: string[], path = "/api/placement/worker/register", method = "POST") {
  return new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: ["Host", `127.0.0.1:${port}`, "Content-Type", "application/json", ...headers], agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end(JSON.stringify(envelope));
  });
}
function upgrade(port: number, authorization: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.end(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: ${authorization}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    let response = "";
    socket.on("data", (chunk) => { response += chunk; }); socket.on("error", reject); socket.on("close", () => resolve(response));
    socket.setTimeout(2000, () => socket.destroy(new Error("Fixture upgrade timeout")));
  });
}
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("placement worker authentication", () => {
  it("does not enroll a worker or initialize absent authorization state", () => {
    const dir = fixture(); const value = credential();
    const source = privateWorkerAuthorizationSource(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(workerVerifier(source, audience)(value.credentialId, value.secret)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("strictly binds the principal and rejects unknown schema, roles, audience, expiry and secrets", () => {
    const value = credential();
    let encoded = JSON.stringify(value.record);
    const source = { read: () => WorkerAuthorizationSchema.parse(JSON.parse(encoded)) };
    const verify = workerVerifier(source, audience, () => 1000);
    expect(verify(value.credentialId, value.secret)).toEqual({ credentialId: value.credentialId, hostId: worker, audience, role: "execution-worker" });
    expect(verify(value.credentialId, randomBytes(32).toString("hex"))).toBeNull();
    for (const change of [{ version: 2 }, { role: "controller" }, { audience: other }, { expiresAt: 999 }, { secretSha256: "bad" }, { rawSecret: "forbidden field" }, { credentialId: randomUUID() }]) {
      encoded = JSON.stringify({ ...value.record, revision: 2, ...change });
      expect(workerVerifier(source, audience, () => 1000)(value.credentialId, value.secret)).toBeNull();
    }
    expect(WorkerAuthorizationSchema.safeParse({ ...value.record, capabilities: ["owner"] }).success).toBe(false);
  });

  it("reads revocation afresh and refuses observed rollback or binding changes without revision", () => {
    const dir = fixture(); const value = credential(); const path = save(dir, value.record);
    const verify = workerVerifier(privateWorkerAuthorizationSource(dir), audience);
    expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
    save(dir, { ...value.record, hostId: other });
    expect(verify(value.credentialId, value.secret)).toBeNull();
    save(dir, { ...value.record, revision: 2, revoked: true });
    expect(verify(value.credentialId, value.secret)).toBeNull();
    save(dir, value.record);
    expect(verify(value.credentialId, value.secret)).toBeNull();
    save(dir, { ...value.record, revision: 3 });
    expect(verify(value.credentialId, value.secret)).toBeNull();
    expect(verify(value.credentialId, value.secret)).toBeNull();
    rmSync(path);
    expect(verify(value.credentialId, value.secret)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("retains trusted revocation observed with a wrong secret after metadata restoration", () => {
    const value = credential(); let record = value.record;
    const verify = workerVerifier({ read: () => record }, audience);
    expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
    record = { ...value.record, revision: 2, revoked: true };
    expect(verify(value.credentialId, "wrong-secret")).toBeNull();
    record = value.record;
    expect(verify(value.credentialId, value.secret)).toBeNull();
    record = { ...value.record, revision: 3 };
    expect(verify(value.credentialId, value.secret)).toBeNull();
    const unrelated = credential(); record = unrelated.record;
    expect(verify(unrelated.credentialId, unrelated.secret)?.hostId).toBe(worker);
  });

  it("latches trusted binding drift and same-revision changes after metadata restoration", () => {
    const changes: Partial<WorkerAuthorization>[] = [
      { revision: 2, hostId: other }, { revision: 2, audience: other },
      { revision: 2, credentialId: randomUUID() }, { revision: 2, secretSha256: "0".repeat(64) },
      { expiresAt: Number.MAX_SAFE_INTEGER },
    ];
    for (const change of changes) {
      const value = credential(); let record = value.record;
      const verify = workerVerifier({ read: () => record }, audience);
      expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
      record = { ...value.record, ...change };
      expect(verify(value.credentialId, value.secret)).toBeNull();
      record = value.record;
      expect(verify(value.credentialId, value.secret)).toBeNull();
      record = { ...value.record, revision: 3 };
      expect(verify(value.credentialId, value.secret)).toBeNull();
    }
  });

  it("retains a higher trusted revision observed with a wrong secret and latches its rollback", () => {
    const value = credential(); let record = value.record;
    const verify = workerVerifier({ read: () => record }, audience);
    expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
    record = { ...value.record, revision: 2 };
    expect(verify(value.credentialId, "wrong-secret")).toBeNull();
    record = value.record;
    expect(verify(value.credentialId, value.secret)).toBeNull();
    record = { ...value.record, revision: 3 };
    expect(verify(value.credentialId, value.secret)).toBeNull();
  });

  it("does not poison a credential from wrong secrets or malformed or foreign first records", () => {
    const value = credential(); let record = value.record;
    const verify = workerVerifier({ read: () => record }, audience);
    expect(verify(value.credentialId, "wrong-secret")).toBeNull();
    expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
    expect(verify(value.credentialId, "another-wrong-secret")).toBeNull();
    expect(verify(value.credentialId, value.secret)?.hostId).toBe(worker);
    for (const change of [{ secretSha256: "malformed" }, { credentialId: randomUUID() }, { audience: other }]) {
      const freshVerifier = workerVerifier({ read: () => record }, audience);
      record = { ...value.record, ...change };
      expect(freshVerifier(value.credentialId, value.secret)).toBeNull();
      record = value.record;
      expect(freshVerifier(value.credentialId, value.secret)?.hostId).toBe(worker);
    }
  });

  it.each(["missing", "public", "public-directory", "link", "symlink", "directory-symlink", "corrupt", "oversized"])("refuses %s metadata without repairing files or following links", (damage) => {
    const dir = fixture(); const value = credential(); const path = save(dir, value.record);
    const parent = join(dir, "placement-worker-authorizations");
    if (damage === "missing") rmSync(path);
    if (damage === "public") chmodSync(path, 0o644);
    if (damage === "public-directory") chmodSync(parent, 0o755);
    if (damage === "link") linkSync(path, join(parent, "alias"));
    if (damage === "symlink") { const target = join(dir, "target"); writeFileSync(target, JSON.stringify(value.record), { mode: 0o600 }); rmSync(path); symlinkSync(target, path); }
    if (damage === "directory-symlink") { const alias = join(dir, "alias"); mkdirSync(alias, { mode: 0o700 }); writeFileSync(join(alias, `${value.credentialId}.json`), JSON.stringify(value.record), { mode: 0o600 }); rmSync(parent, { recursive: true }); symlinkSync(alias, parent); }
    if (damage === "corrupt") writeFileSync(path, "{");
    if (damage === "oversized") writeFileSync(path, " ".repeat(16_385));
    const entries = readdirSync(parent);
    const bytes = existsSync(path) ? readFileSync(path) : null;
    const mode = existsSync(path) ? statSync(path).mode : null;
    const directoryMode = statSync(parent).mode;
    expect(workerVerifier(privateWorkerAuthorizationSource(dir), audience)(value.credentialId, value.secret)).toBeNull();
    expect(readdirSync(parent)).toEqual(entries);
    expect(statSync(parent).mode).toBe(directoryMode);
    if (bytes) { expect(readFileSync(path)).toEqual(bytes); expect(statSync(path).mode).toBe(mode); }
    else expect(existsSync(path)).toBe(false);
  });

  it("rejects malformed or owner-route claims before metadata, and rechecks revocation after a body wait", async () => {
    const value = credential(); let reads = 0; let ownerCalls = 0; let record = value.record;
    const boundary = createWorkerRequestBoundary({ audience, source: { read: () => { reads++; return record; } }, readBody: async () => { record = { ...record, revision: 2, revoked: true }; return envelope; } });
    const port = await listen(createServer((req, res) => { void boundary(req, res).then((handled) => { if (!handled) { ownerCalls++; res.end("owner"); } }); }));
    expect((await send(port, value.authorization, "/api/config", undefined, "GET")).status).toBe(403);
    expect((await send(port, "BotFleet-Worker malformed")).status).toBe(403);
    expect((await send(port, value.authorization, undefined, undefined, undefined, { origin: "https://elsewhere.invalid" })).status).toBe(403);
    expect(reads).toBe(0); expect(ownerCalls).toBe(0);
    expect((await send(port, value.authorization)).status).toBe(403);
    expect(reads).toBe(2); expect(ownerCalls).toBe(0);
  });

  it("refuses worker redirects and cookies while preserving the ordinary owner proxy", async () => {
    const value = credential(); const log: string[] = [];
    const upstream = await listen(createServer((_req, res) => { res.writeHead(307, { location: "https://elsewhere.invalid/credential", "set-cookie": "owner=forbidden" }); res.end(); }));
    const gate = await listen(createOwnerGate({ owners: "owner@example.invalid", harnessPort: upstream, log: (line) => log.push(line) }));
    const response = await send(gate, value.authorization);
    expect(response.status).toBe(502); expect(response.headers.get("location")).toBeNull(); expect(response.headers.get("set-cookie")).toBeNull();
    const ordinary = await fetch(`http://127.0.0.1:${gate}/owner`, { headers: { "tailscale-user-login": "owner@example.invalid" }, redirect: "manual" });
    expect(ordinary.status).toBe(307); expect(ordinary.headers.get("location")).toBe("https://elsewhere.invalid/credential");
    expect(log.join("\n")).not.toContain(value.secret);
  });

  it("enforces worker authority through the real harness and gateway without granting owner or transport access", async () => {
    const home = fixture(); const dir = join(home, ".botfleet"); mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "host-id"), audience, { mode: 0o600 });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver" } } }));
    const value = credential(); save(dir, value.record);
    const port = await freePortBlock([0, 1]); const base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | undefined; let stderr = ""; const log: string[] = [];
    try {
      child = spawnDetached(process.execPath, [fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, TZ: "America/Chicago", VITEST: "true", OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_DISABLE_ANTIGRAVITY_QUOTA: "1" }, stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      const deadline = Date.now() + 30_000;
      while (!await harnessReady(base, 1000)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Isolated harness failed to start: ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const gate = await listen(createOwnerGate({ owners: "owner@example.invalid", harnessPort: port, log: (line) => log.push(line) }));
      const controllerBefore = readFileSync(join(dir, "placement-controller.json"));
      const configBefore = readFileSync(join(dir, "config.json"));
      for (const target of [port, gate]) {
        for (const intent of WORKER_INTENTS) {
          const response = await send(target, value.authorization, `/api/placement/worker/${intent}`);
          expect(response.status, intent).toBe(503);
          expect(await response.json()).toEqual({ error: "Worker transport is not active" });
        }
        for (const body of [{ ...envelope, hostId: other }, { ...envelope, audience: other }, { ...envelope, role: "controller" }, { ...envelope, authVersion: "2" }, { ...envelope, executionReceiptVersion: "1" }, { ...envelope, capabilities: ["owner"] }]) expect((await send(target, value.authorization, undefined, body)).status).toBe(403);
        for (const path of ["/api/config", "/api/runtime", "/api/update/status", "/api/credentials", "/api/tools", "/api/transcript", "/api/placement/identity", "/ws"]) expect((await send(target, value.authorization, path, undefined, "GET")).status, path).toBe(403);
        for (const path of ["/api/placement/enqueue", "/api/placement/takeover", "/api/placement/release-controller", "/api/placement/claim", "/api/update/run", "/api/config", "/api/placement/worker/register?redirect=1", "/api/placement/worker/register/", "/api/placement/worker/%72egister"]) expect((await send(target, value.authorization, path)).status, path).toBe(403);
        for (const extra of [{ "x-host-id": other }, { "x-botfleet-host-id": other }, { "x-botfleet-worker": "1" }, { "x-botfleet-gate-token": "owner" }, { "tailscale-user-login": "owner@example.invalid" }, { cookie: "owner=1" }, { origin: "https://elsewhere.invalid" }, { "sec-fetch-site": "cross-site" }, { "x-forwarded-for": "127.0.0.1" }, { connection: "authorization" }]) expect((await send(target, value.authorization, undefined, undefined, undefined, extra)).status).toBe(403);
        expect(await raw(target, ["Authorization", value.authorization, "Authorization", value.authorization])).toBe(403);
        expect(await raw(target, ["Authorization", "Bearer owner", "Authorization", value.authorization])).toBe(403);
        expect((await send(target, value.authorization.replace("BotFleet-Worker", "Bearer"), "/api/config", undefined, "GET")).status).toBe(403);
        expect((await send(target, credential().authorization)).status).toBe(403);
      }
      expect(await upgrade(gate, value.authorization)).toContain("403 Forbidden");
      expect(await upgrade(port, value.authorization)).toContain("403 Forbidden");
      expect((await send(port, value.authorization, undefined, undefined, undefined, { host: "elsewhere.invalid" })).status).toBe(403);
      expect((await fetch(`${base}/api/placement/identity`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${gate}/api/placement/identity`, { headers: { "tailscale-user-login": "owner@example.invalid" } })).status).toBe(200);
      save(dir, { ...value.record, revision: 2, audience: other });
      expect((await send(port, value.authorization)).status).toBe(403); expect((await send(gate, value.authorization)).status).toBe(403);
      save(dir, { ...value.record, revision: 3, revoked: true });
      expect((await send(port, value.authorization)).status).toBe(403); expect((await send(gate, value.authorization)).status).toBe(403);
      expect(readFileSync(join(dir, "placement-controller.json"))).toEqual(controllerBefore);
      expect(readFileSync(join(dir, "config.json"))).toEqual(configBefore);
      expect(existsSync(join(dir, "placement.sqlite"))).toBe(false);
      expect(existsSync(join(dir, "placement-payloads"))).toBe(false);
      expect(stderr + log.join("\n")).not.toContain(value.secret);
    } finally { if (child) await waitForExit(child, { signal: "SIGTERM" }); }
  }, 45_000);
});
