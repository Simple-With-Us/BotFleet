// Queued room rounds and the live speaker (audit G16).
//
// A round that waited on a busy bot used to fire straight out of the drain,
// beside whatever the room was already doing.  On a shared provider
// instance the late dispatch found the instance owned, threw on the turn
// claim — but only AFTER it had moved the busy flags, so the real speaker's
// release no-opped against a busy slot it no longer owned and the room
// showed a speaker that was gone until restart.  On two instances both
// members simply spoke at once, and the per-thread speaker, busy slot and
// fallback waiter crossed.
//
// The fix runs drained rounds on the room's own operation queue and claims
// the turn before any flag moves.  These tests hold provider turns at
// named gates so the interleave is exact: a drained round becomes runnable
// while another member's turn is still live in the same room.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

interface WireMessage {
  role?: string;
  kind?: string;
  text?: string;
  tool?: { name?: string; ok?: boolean };
}

describe("queued room rounds wait for the live speaker", () => {
  let child: ChildProcess;
  let engineA: FakeOpenAiServer; // the "minimax" instance
  let engineB: FakeOpenAiServer; // the "openai-compat" instance
  let home: string;
  let base: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const waitFor = async <T,>(probe: () => Promise<T | null>, ms: number): Promise<T | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const messages = async (threadId: string): Promise<WireMessage[]> =>
    ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []) as WireMessage[];

  const replies = async (threadId: string): Promise<string[]> =>
    (await messages(threadId))
      .filter((m) => m.role === "bot" && m.kind !== "activity" && typeof m.text === "string" && m.text.trim())
      .map((m) => m.text!.trim());

  const activity = async (threadId: string): Promise<string[]> =>
    (await messages(threadId)).filter((m) => m.kind === "activity").map((m) => m.tool?.name ?? "");

  const groupState = async (groupId: string): Promise<any> =>
    ((await api("GET", "/api/bots")).body.groups ?? []).find((g: { id: string }) => g.id === groupId);

  const waitForRoomIdle = async (groupId: string, ms = 30_000) =>
    waitFor(async () => {
      const group = await groupState(groupId);
      return group && !group.busyBotId && !group.working ? group : null;
    }, ms);

  const waitForBotIdle = async (botId: string, ms = 30_000) =>
    waitFor(async () => {
      const bot = ((await api("GET", "/api/bots")).body.bots ?? []).find((b: { id: string }) => b.id === botId);
      return bot && !bot.busy ? bot : null;
    }, ms);

  const completionCount = (engine: FakeOpenAiServer) =>
    engine.requests.filter((r) => r.url.includes("/chat/completions")).length;

  const waitForCompletions = async (engine: FakeOpenAiServer, n: number, ms = 30_000) =>
    waitFor(async () => (completionCount(engine) >= n ? true : null), ms);

  const makeBot = async (name: string, instanceId = "minimax") => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name,
      computers: [],
      modelSelection: { instanceId, model: "MiniMax-M3" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  const makeRoom = async (name: string, memberIds: string[], responder: Record<string, unknown>) => {
    const created = await api("POST", "/api/groups", {
      name,
      memberIds,
      setup: { bulletin: "", defaultResponder: responder },
    });
    expect(created.status).toBe(201);
    return created.body.group;
  };

  beforeAll(async () => {
    engineA = await startFakeOpenAiServer();
    engineB = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-room-drain-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          minimax: {
            driver: "minimax",
            config: { url: engineA.url },
            environment: { MINIMAX_API_KEY: "fake-key-for-tests" },
          },
          "openai-compat": {
            driver: "openai-compat",
            config: { url: engineB.url },
            environment: { OPENAI_COMPAT_API_KEY: "fake-key-for-tests" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const port = await freePortBlock([0]);
    base = `http://127.0.0.1:${port}`;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await engineA?.close();
    await engineB?.close();
    await removeTempDir(home);
  });

  it(
    "shared provider instance: a drained round waits for the live speaker instead of cross-wiring the room",
    async () => {
      const alpha = await makeBot("alpha");
      const bravo = await makeBot("bravo");
      const room = await makeRoom("Drain-shared", [alpha.id, bravo.id], { kind: "member", botId: alpha.id });

      // bravo is mid-1:1, held at the provider.
      engineA.queueCompletion({ kind: "gate", gate: "bravo-1v1", then: says("bravo one-on-one done") });
      expect((await api("POST", `/api/bots/${bravo.id}/messages`, { text: "hold this" })).status).toBe(202);
      expect(await waitForCompletions(engineA, 1), "bravo's 1:1 never reached the provider").toBeTruthy();

      // A room round for bravo waits: he is busy elsewhere.
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@bravo room question" })).status).toBe(202);
      expect(
        await waitFor(
          async () => ((await activity(room.threadId)).some((n) => n.includes("queued for when it frees up")) ? true : null),
          10_000,
        ),
        "bravo's room round never queued",
      ).toBeTruthy();

      // alpha takes the room and holds at the provider — same instance.
      engineA.queueCompletion({ kind: "gate", gate: "alpha-room", then: says("alpha speaking") });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@alpha please answer" })).status).toBe(202);
      expect(await waitForCompletions(engineA, 2), "alpha's room turn never reached the provider").toBeTruthy();
      expect(
        await waitFor(async () => ((await groupState(room.id))?.busyBotId === alpha.id ? true : null), 10_000),
        "alpha never became the speaker",
      ).toBeTruthy();

      // bravo's 1:1 settles.  The drain now wants to run his queued round
      // while alpha's turn owns the instance in this room.  Before the fix
      // that dispatch threw on the claim after moving the busy flags, which
      // stranded the room on a speaker that never ran.
      engineA.releaseGate("bravo-1v1");
      expect(await waitForBotIdle(bravo.id), "bravo's 1:1 never settled").toBeTruthy();
      await new Promise((r) => setTimeout(r, 1500)); // let a wrongly-fired drain land
      expect(completionCount(engineA)).toBe(2); // bravo's round did NOT start beside alpha
      expect((await groupState(room.id)).busyBotId).toBe(alpha.id); // alpha is still the speaker

      // alpha finishes; the drained round follows on the room's own queue.
      engineA.queueCompletion(says("bravo in the room"));
      engineA.releaseGate("alpha-room");
      expect(await waitForRoomIdle(room.id), `the room kept its speaker. stderr:\n${stderr}`).toBeTruthy();
      expect(await replies(room.threadId)).toEqual(["alpha speaking", "bravo in the room"]);
      expect(completionCount(engineA)).toBe(3);
      expect(await waitForBotIdle(alpha.id)).toBeTruthy();
    },
    120_000,
  );

  it(
    "two provider instances: a drained round still lines up behind the live speaker",
    async () => {
      const harper = await makeBot("harper"); // minimax (engineA)
      const reese = await makeBot("reese", "openai-compat"); // engineB
      const room = await makeRoom("Drain-split", [harper.id, reese.id], { kind: "member", botId: harper.id });

      // reese is mid-1:1 on her own engine, held at the provider.
      engineB.queueCompletion({ kind: "gate", gate: "reese-1v1", then: says("reese one-on-one done") });
      expect((await api("POST", `/api/bots/${reese.id}/messages`, { text: "hold this" })).status).toBe(202);
      expect(await waitForCompletions(engineB, 1), "reese's 1:1 never reached the provider").toBeTruthy();

      // Her room round waits.
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@reese room question" })).status).toBe(202);
      expect(
        await waitFor(
          async () => ((await activity(room.threadId)).some((n) => n.includes("queued for when it frees up")) ? true : null),
          10_000,
        ),
        "reese's room round never queued",
      ).toBeTruthy();

      // harper takes the room on the other engine and holds.
      engineA.queueCompletion({ kind: "gate", gate: "harper-room", then: says("harper speaking") });
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@harper please answer" })).status).toBe(202);
      expect(await waitForCompletions(engineA, 1), "harper's room turn never reached the provider").toBeTruthy();
      expect(
        await waitFor(async () => ((await groupState(room.id))?.busyBotId === harper.id ? true : null), 10_000),
        "harper never became the speaker",
      ).toBeTruthy();

      // reese's 1:1 settles.  Even with a free engine of her own, her round
      // must not speak beside harper: one speaker per room.
      engineB.releaseGate("reese-1v1");
      expect(await waitForBotIdle(reese.id), "reese's 1:1 never settled").toBeTruthy();
      await new Promise((r) => setTimeout(r, 1500)); // let a wrongly-fired drain land
      expect(completionCount(engineB)).toBe(1); // her room round did NOT start beside harper
      expect((await groupState(room.id)).busyBotId).toBe(harper.id);

      // harper finishes; reese's round follows.
      engineB.queueCompletion(says("reese in the room"));
      engineA.releaseGate("harper-room");
      expect(await waitForRoomIdle(room.id), `the room kept its speaker. stderr:\n${stderr}`).toBeTruthy();
      expect(await replies(room.threadId)).toEqual(["harper speaking", "reese in the room"]);
      expect(completionCount(engineB)).toBe(2);
    },
    120_000,
  );
});
