// Slash commands through the Claude driver, against the scripted fake CLI.
//
// Two jobs.  A message a person typed must never reach the CLI as one of its
// own commands: "/advisor opus" bare on stdin rewrote advisorModel in the
// owner's global settings.  And a command BotFleet does mean to run
// (`SendTurnInput.command`) must be written alone, with nothing in front of
// it, because the CLI parses a command only at the very start of a message.
import { chmodSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ClaudeDriver, withVolatileNote } from "./claude.ts";
import { SLASH_NEUTRALIZER } from "./engine-commands.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");

describe("Claude slash commands (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let prompts: string;

  const create = async () => {
    instance = await ClaudeDriver.create({
      instanceId: "claude-commands-test",
      displayName: "Claude Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };

  /** every user message the fake CLI read, in order, as the CLI saw it */
  const sent = (): Array<{ pid: number; content: string }> =>
    existsSync(prompts)
      ? readFileSync(prompts, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const entry = JSON.parse(line);
            return { pid: entry.pid, content: entry.prompt.message.content };
          })
      : [];

  /** the session id the CLI announced for the first turn, which the next turn resumes */
  const sessionOf = (): string => {
    const started = recorder.events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started" || !started.sessionId) throw new Error("no session was announced");
    return started.sessionId;
  };

  const settled = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-claude-commands-"));
    process.env.FAKE_CLAUDE_COST_DIR = join(scratch, "costs");
    prompts = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_PROMPTS = prompts;
  });

  afterEach(async () => {
    for (const name of [
      "FAKE_CLAUDE_MODE",
      "FAKE_CLAUDE_PROMPTS",
      "FAKE_CLAUDE_COST_DIR",
      "FAKE_CLAUDE_SLASH_COMMANDS",
      "FAKE_CLAUDE_TRANSIENTS",
      "FAKE_CLAUDE_STATE",
      "FAKE_CLAUDE_RETRY_SCALE",
    ]) {
      delete process.env[name];
    }
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  describe("a message that merely starts with a slash", () => {
    it("is shielded on the first turn and on a reused process", async () => {
      await create();
      const first = await instance.adapter.sendTurn({ threadId: "t-shield", text: "/advisor opus" });
      await settled(first.turnId);
      const announced = sessionOf();
      const second = await instance.adapter.sendTurn({ threadId: "t-shield", text: "/model claude-x", resumeCursor: announced });
      await settled(second.turnId);

      expect(sent().map((p) => p.content)).toEqual([`${SLASH_NEUTRALIZER}/advisor opus`, `${SLASH_NEUTRALIZER}/model claude-x`]);
      // one process the whole way: the warm path is shielded as well as the cold one
      expect(new Set(sent().map((p) => p.pid)).size).toBe(1);
    });

    it("leaves any other message byte for byte as it was", async () => {
      await create();
      const turn = await instance.adapter.sendTurn({ threadId: "t-plain", text: "please read /etc/hosts" });
      await settled(turn.turnId);
      expect(sent().map((p) => p.content)).toEqual(["please read /etc/hosts"]);
    });

    it("is shielded after the volatile note too, so the note can never expose a command", async () => {
      await create();
      const stable = "You are Testy.";
      const memory = " Memory: likes tea";
      const turn = await instance.adapter.sendTurn({
        threadId: "t-note",
        text: "/config",
        system: stable + memory,
        systemStable: stable,
        systemVolatile: memory,
      });
      await settled(turn.turnId);
      // the note leads, so the text is not at the start; the note itself is untouched
      expect(sent().map((p) => p.content)).toEqual([withVolatileNote("/config", memory, false)]);
    });

    it("is shielded when it is steered into a running turn", async () => {
      process.env.FAKE_CLAUDE_MODE = "slow";
      await create();
      const turn = await instance.adapter.sendTurn({ threadId: "t-steer-shield", text: "first" });
      await expect(instance.adapter.steer!("t-steer-shield", "/model sonnet")).resolves.toBe(true);
      await settled(turn.turnId);
      expect(sent().map((p) => p.content)).toEqual(["first", `${SLASH_NEUTRALIZER}/model sonnet`]);
    });
  });

  describe("a command turn", () => {
    const split = (volatile: string) => ({ system: `Rules.${volatile}`, systemStable: "Rules.", systemVolatile: volatile });

    it("writes exactly the command and its single argument line, at both call sites", async () => {
      await create();
      // cold spawn
      const first = await instance.adapter.sendTurn({ threadId: "t-cmd", text: "ignored", command: { name: "compact" } });
      await settled(first.turnId);
      const announced = sessionOf();
      // warm process
      const second = await instance.adapter.sendTurn({
        threadId: "t-cmd",
        text: "ignored",
        resumeCursor: announced,
        command: { name: "compact", args: "focus on tests" },
      });
      await settled(second.turnId);

      expect(sent().map((p) => p.content)).toEqual(["/compact", "/compact focus on tests"]);
      expect(new Set(sent().map((p) => p.pid)).size).toBe(1);
    });

    it("carries no volatile note, and leaves the receipt so the next ordinary turn still delivers it", async () => {
      await create();
      const memory = " Memory: likes tea";
      const command = await instance.adapter.sendTurn({ threadId: "t-cmd-note", text: "x", command: { name: "context" }, ...split(memory) });
      await settled(command.turnId);
      const announced = sessionOf();
      expect(sent().map((p) => p.content)).toEqual(["/context"]);

      const next = await instance.adapter.sendTurn({ threadId: "t-cmd-note", text: "hello", resumeCursor: announced, ...split(memory) });
      await settled(next.turnId);
      expect(sent().at(-1)?.content).toBe(withVolatileNote("hello", memory, false));
    });

    it("refuses a name the denylist forbids, before anything is written", async () => {
      await create();
      await expect(
        instance.adapter.sendTurn({ threadId: "t-cmd-denied", text: "x", command: { name: "advisor", args: "opus" } }),
      ).rejects.toThrow(/not a command/);
      expect(sent()).toEqual([]);
    });

    it("is not relaunched when the CLI dies, so a command can never run twice", async () => {
      process.env.FAKE_CLAUDE_TRANSIENTS = "1";
      process.env.FAKE_CLAUDE_STATE = join(scratch, "launches");
      process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
      await create();
      const turn = await instance.adapter.sendTurn({ threadId: "t-cmd-crash", text: "x", command: { name: "compact" } });
      const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turn.turnId, 60_000);
      expect(done).toMatchObject({ type: "turn.completed", ok: false });
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toEqual([]);
      expect(sent().map((p) => p.content)).toEqual(["/compact"]);
    }, 90_000);

    it("still relaunches an ordinary turn on the same transient failure", async () => {
      process.env.FAKE_CLAUDE_TRANSIENTS = "1";
      process.env.FAKE_CLAUDE_STATE = join(scratch, "launches-plain");
      process.env.FAKE_CLAUDE_RETRY_SCALE = "0.001";
      await create();
      await instance.adapter.sendTurn({ threadId: "t-plain-crash", text: "hello" });
      // the relaunch is a fresh turn with its own id, so wait on the settle, not the first id
      const done = await recorder.until((e) => e.type === "turn.completed", 60_000);
      expect(done).toMatchObject({ type: "turn.completed", ok: true });
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    }, 90_000);
  });

  describe("discovery from the init frame", () => {
    it("announces the CLI's commands once, normalized, and again only when the set changes", async () => {
      process.env.FAKE_CLAUDE_SLASH_COMMANDS = "compact,/Context,compact,my-plugin:review,review";
      await create();
      const first = await instance.adapter.sendTurn({ threadId: "t-discover", text: "hi" });
      await settled(first.turnId);
      const announced = sessionOf();
      // the real CLI re-announces init on every turn of a live process
      const second = await instance.adapter.sendTurn({ threadId: "t-discover", text: "again", resumeCursor: announced });
      await settled(second.turnId);

      const events = recorder.events.filter((e) => e.type === "engine.commands");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "engine.commands",
        names: ["compact", "context", "review"],
        origin: "claude-init",
        provider: "claudeAgent",
      });
    });

    it("says nothing when the init frame lists no commands", async () => {
      await create();
      const turn = await instance.adapter.sendTurn({ threadId: "t-no-list", text: "hi" });
      await settled(turn.turnId);
      expect(recorder.events.filter((e) => e.type === "engine.commands")).toEqual([]);
    });

    it("declares the capability that makes a command menu worth showing", async () => {
      await create();
      expect(instance.adapter.capabilities.engineCommands).toBe(true);
    });
  });
});
