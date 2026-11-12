import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Regression coverage for board dc91bbc0: "Box cloud desktops pool 4 ways:
// two bots silently share one VM/mouse/Chrome profile, and Sleep archives a
// peer's live VM." #117 hetzner pooling hashes a bot id's SHA-256 first byte
// mod 4 into one of four shared `ogb-pool-N` names, so any two bots can land
// on the same box. Pigeonhole guarantees a collision inside 5 tries.
function poolIndex(botId: string): number {
  return createHash("sha256").update(botId).digest()[0] % 4;
}
function collidingBotIdPair(): [string, string] {
  const seenAt = new Map<number, string>();
  for (let i = 0; ; i++) {
    const id = `pool-bot-${i}`;
    const idx = poolIndex(id);
    const seen = seenAt.get(idx);
    if (seen) return [seen, id];
    seenAt.set(idx, id);
  }
}
const [botA, botB] = collidingBotIdPair();
const sharedPoolName = `ogb-pool-${poolIndex(botA)}`;

function startStubBoxApi(requests: Array<{ method: string; path: string }>) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://box.test");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method ?? "GET", path: url.pathname });
      res.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/api/box/v1/boxes") {
        res.end(JSON.stringify({ boxes: [{ id: "shared-box-1", name: sharedPoolName, state: "ready" }] }));
      } else if (url.pathname === "/api/box/v1/boxes/shared-box-1" && req.method === "GET") {
        // Single-box lookup, used by waitReady's polling — must echo the
        // same ready state or it spins forever waiting for a state change.
        res.end(JSON.stringify({ ok: true, box: { id: "shared-box-1", name: sharedPoolName, state: "ready" } }));
      } else if (url.pathname.endsWith("/desktop")) {
        res.end(JSON.stringify({ desktopUrl: `https://desktop.test/${Math.random()}` }));
      } else if (url.pathname.endsWith("/commands")) {
        res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
}

const cfg = { box: { token: "box_test" } } as any;

describe("box pool occupancy guard", () => {
  let api: Server;
  let box: typeof import("./box.ts");
  const requests: Array<{ method: string; path: string }> = [];

  beforeAll(async () => {
    api = startStubBoxApi(requests);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    box = await import("./box.ts");
  });

  afterEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("refuses to sleep a box a different bot just joined", async () => {
    await box.joinBox(cfg, botA);
    await expect(box.sleepBox(cfg, botB)).rejects.toThrow(/someone else is using this computer/i);
    expect(requests.some((r) => r.path.endsWith("/stop"))).toBe(false);
  });

  it("still lets the occupant bot sleep its own box", async () => {
    await box.joinBox(cfg, botA);
    await expect(box.sleepBox(cfg, botA)).resolves.toEqual({ ok: true });
    expect(requests.some((r) => r.path.endsWith("/stop"))).toBe(true);
  });

  it("surfaces the collision in boxStatus.sharedWithBotId", async () => {
    await box.joinBox(cfg, botA);
    const status = await box.boxStatus(cfg, botB);
    expect(status.box?.sharedWithBotId).toBe(botA);
  });
});

describe("box pool occupancy guard — stale claim", () => {
  let api: Server;
  let box: typeof import("./box.ts");
  const requests: Array<{ method: string; path: string }> = [];

  beforeAll(async () => {
    api = startStubBoxApi(requests);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.stubEnv("OMB_BOX_POOL_OCCUPANT_TTL_MS", "20"); // shrink the TTL instead of faking global timers
    vi.resetModules();
    box = await import("./box.ts");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("lets sleep through once the other bot's claim goes stale", async () => {
    await box.joinBox(cfg, botA);
    await new Promise((resolve) => setTimeout(resolve, 40)); // past the 20ms TTL
    await expect(box.sleepBox(cfg, botB)).resolves.toEqual({ ok: true });
    expect(requests.some((r) => r.path.endsWith("/stop"))).toBe(true);
  });
});

// Sentry review finding on PR #445 (ref 16797767): joinBox called
// claimOccupant unconditionally after mintDesktopUrl, even when the provider
// failed to mint a link — a false occupancy claim that would block a peer
// bot's Sleep and could trigger a bogus Sentry collision report the next
// time someone actually joined. provisionBox already guarded this; joinBox
// now does too.
describe("box pool occupancy guard — failed join", () => {
  let api: Server;
  let box: typeof import("./box.ts");

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (url.pathname === "/api/box/v1/boxes") {
          res.end(JSON.stringify({ boxes: [{ id: "shared-box-1", name: sharedPoolName, state: "ready" }] }));
        } else if (url.pathname === "/api/box/v1/boxes/shared-box-1" && req.method === "GET") {
          res.end(JSON.stringify({ ok: true, box: { id: "shared-box-1", name: sharedPoolName, state: "ready" } }));
        } else if (url.pathname.endsWith("/desktop")) {
          // Simulate the provider never producing a desktop link.
          res.end(JSON.stringify({ ok: true }));
        } else if (url.pathname.endsWith("/commands")) {
          res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    box = await import("./box.ts");
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("does not claim occupancy when mintDesktopUrl fails to return a link", async () => {
    await expect(box.joinBox(cfg, botA)).rejects.toThrow(/desktop link could not be created/);
    const status = await box.boxStatus(cfg, botB);
    expect(status.box?.sharedWithBotId).toBeNull();
  });
});
