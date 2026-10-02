import { describe, expect, it } from "vitest";

import {
  ENGINE_COMMAND_ALLOWLIST,
  engineCommandText,
  hasEngineCommandAllowlist,
  isDeniedEngineCommand,
  neutralizeLeadingSlash,
  normalizeAnnouncedCommands,
  normalizeEngineCommandName,
  offeredEngineCommands,
  SLASH_NEUTRALIZER,
  type EngineCommandSpec,
} from "./engine-commands.ts";

const spec = (name: string, cliVersion = "2.1.0"): EngineCommandSpec => ({
  name,
  title: name,
  description: `Runs ${name}.`,
  args: null,
  output: "local",
  requiresSession: false,
  runsModelTurn: false,
  provenOn: { cliVersion, date: "2026-10-02" },
});

describe("neutralizeLeadingSlash", () => {
  it("shields a message whose first non-blank character is a slash", () => {
    expect(neutralizeLeadingSlash("/advisor opus")).toBe(`${SLASH_NEUTRALIZER}/advisor opus`);
    expect(neutralizeLeadingSlash("  \n/model x")).toBe(`${SLASH_NEUTRALIZER}  \n/model x`);
  });

  it("leaves every other message byte for byte as it was", () => {
    for (const text of ["hello", "see /etc/hosts", "a/b", "", "   ", "<system-reminder>\nx\n</system-reminder>\n\n/advisor"]) {
      expect(neutralizeLeadingSlash(text)).toBe(text);
    }
  });

  it("is idempotent, and the shield survives the trim a command parser does", () => {
    const once = neutralizeLeadingSlash("/config");
    expect(neutralizeLeadingSlash(once)).toBe(once);
    expect(once.trim().startsWith("/")).toBe(false);
    expect(once.trimStart().codePointAt(0)).toBe(0x200b);
  });
});

describe("command names", () => {
  it("normalizes to lowercase words with no slash", () => {
    expect(normalizeEngineCommandName("/Compact")).toBe("compact");
    expect(normalizeEngineCommandName(" security-review ")).toBe("security-review");
  });

  it("refuses a plugin- or project-scoped name and anything that is not a word", () => {
    for (const raw of ["plugin:thing", "a/b", "", "/", "9lives", "two words", "x_y"]) {
      expect(normalizeEngineCommandName(raw)).toBeNull();
    }
  });

  it("dedupes an announced list in first-seen order and drops what is not a plain name", () => {
    expect(normalizeAnnouncedCommands(["/compact", "Context", "compact", "my:plugin", "", "review"])).toEqual([
      "compact",
      "context",
      "review",
    ]);
  });
});

describe("isDeniedEngineCommand", () => {
  it.each([
    "advisor",
    "/advisor",
    "Model",
    "models",
    "effort",
    "fast",
    "config",
    "settings",
    "permissions",
    "allowed-tools",
    "approval-mode",
    "login",
    "logout",
    "auth",
    "status",
    "help",
    "clear",
    "reset",
    "new",
    "resume",
    "continue",
    "rewind",
    "exit",
    "quit",
    "output-style",
    "theme",
    "vim",
    "statusline",
    "terminal-setup",
    "memory",
    "mcp",
    "hooks",
    "agents",
    "plugin",
    "plugins",
    "skills",
    "init",
    "add-dir",
    "export",
    "ide",
    "install-github-app",
    "install-slack-app",
    "upgrade",
    "update",
    "privacy-settings",
    "usage",
    "extra-usage",
    "doctor",
    "bug",
    "feedback",
    "sandbox",
    "mode",
  ])("denies %s", (name) => {
    expect(isDeniedEngineCommand(name)).toBe(true);
  });

  it("denies a name that merely sounds like it touches an account, a key or a model", () => {
    for (const name of ["my-config", "switch-model", "api-key", "billing-info", "set-token", "reauth", "planning"]) {
      expect(isDeniedEngineCommand(name)).toBe(true);
    }
  });

  it("denies a scoped name", () => {
    expect(isDeniedEngineCommand("plugin:review")).toBe(true);
    expect(isDeniedEngineCommand("project/review")).toBe(true);
  });

  it("does not deny the commands the first release is built around", () => {
    for (const name of ["compact", "compress", "context", "review", "security-review"]) {
      expect(isDeniedEngineCommand(name)).toBe(false);
    }
  });
});

describe("offeredEngineCommands", () => {
  const allowlist = {
    claudeAgent: [spec("compact"), spec("context"), spec("review")],
    grokAgent: [spec("compress", "1.0.0")],
  };

  it("ships with an empty allowlist unless a probe has proven an entry", () => {
    for (const [driverKind, entries] of Object.entries(ENGINE_COMMAND_ALLOWLIST)) {
      for (const entry of entries) {
        expect(isDeniedEngineCommand(entry.name), `${driverKind}:${entry.name}`).toBe(false);
        expect(entry.provenOn.cliVersion, `${driverKind}:${entry.name}`).toMatch(/\d+\.\d+/);
      }
    }
    expect(offeredEngineCommands("nobody", ["compact"], "2.1.0")).toEqual([]);
  });

  it("is the allowlist narrowed to what the engine announced, in allowlist order", () => {
    const offered = offeredEngineCommands("claudeAgent", ["review", "/Compact", "extra"], "2.1.5", allowlist);
    expect(offered.map((entry) => entry.name)).toEqual(["compact", "review"]);
  });

  it("offers nothing for an engine with no entries or nothing announced", () => {
    expect(offeredEngineCommands("codex", ["compact"], "2.1.0", allowlist)).toEqual([]);
    expect(offeredEngineCommands("claudeAgent", [], "2.1.0", allowlist)).toEqual([]);
    expect(offeredEngineCommands("constructor", ["compact"], "2.1.0", allowlist)).toEqual([]);
  });

  it("lets the denylist win even when someone allowlists a denied name", () => {
    const risky = { claudeAgent: [spec("advisor"), spec("compact"), spec("my-config")] };
    expect(offeredEngineCommands("claudeAgent", ["advisor", "compact", "my-config"], "2.1.0", risky).map((e) => e.name)).toEqual([
      "compact",
    ]);
  });

  it("applies an entry only on the major version it was proven on, or a later release of it", () => {
    const entries = { claudeAgent: [spec("compact", "2.1.4")] };
    const offered = (version: string | null) => offeredEngineCommands("claudeAgent", ["compact"], version, entries).length;
    expect(offered("2.1.4 (Claude Code)")).toBe(1);
    expect(offered("2.1.284 (Claude Code)")).toBe(1);
    expect(offered("2.2.0")).toBe(1);
    expect(offered("2.1.3")).toBe(0);
    expect(offered("1.9.9")).toBe(0);
    expect(offered("3.0.0")).toBe(0);
    expect(offered(null)).toBe(0);
    expect(offered("no version here")).toBe(0);
  });

  it("takes the title and description from the entry, never from the engine", () => {
    const [offered] = offeredEngineCommands("grokAgent", ["compress"], "1.0.46", allowlist);
    expect(offered?.description).toBe("Runs compress.");
    expect(hasEngineCommandAllowlist("grokAgent", allowlist)).toBe(true);
    expect(hasEngineCommandAllowlist("codex", allowlist)).toBe(false);
  });
});

describe("engineCommandText", () => {
  it("is the slash, the name, and one optional argument line", () => {
    expect(engineCommandText({ name: "compact" })).toBe("/compact");
    expect(engineCommandText({ name: "compact", args: "  focus on tests " })).toBe("/compact focus on tests");
    expect(engineCommandText({ name: "compact", args: "   " })).toBe("/compact");
  });

  it("refuses a denied or malformed name", () => {
    for (const name of ["advisor", "model", "/compact", "Compact", "a b", ""]) {
      expect(() => engineCommandText({ name })).toThrow();
    }
  });

  it("refuses an argument that could become a second line or a second command", () => {
    expect(() => engineCommandText({ name: "compact", args: "a\nb" })).toThrow();
    expect(() => engineCommandText({ name: "compact", args: "a b" })).toThrow();
    expect(() => engineCommandText({ name: "compact", args: "/model x" })).toThrow();
    expect(() => engineCommandText({ name: "compact", args: "x".repeat(501) })).toThrow();
    expect(engineCommandText({ name: "compact", args: "x".repeat(500) })).toHaveLength("/compact ".length + 500);
  });
});
