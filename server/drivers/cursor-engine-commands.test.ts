import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { offeredEngineCommands } from "./engine-commands.ts";
import {
  buildCursorAgentAllowlist,
  CURSOR_AGENT_BUILTIN_COMMANDS,
  CURSOR_BUILTIN_COMMAND_NAMES,
  discoverCursorCommandCatalog,
  parseCursorCommandFrontmatter,
} from "./cursor-engine-commands.ts";

describe("parseCursorCommandFrontmatter", () => {
  it("reads description and argument-hint fields", () => {
    const fields = parseCursorCommandFrontmatter(`---
description: Ship checklist
argument-hint: branch name
---
# body
`);
    expect(fields).toEqual({ description: "Ship checklist", "argument-hint": "branch name" });
  });
});

describe("discoverCursorCommandCatalog", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-cursor-cmd-"));
  });

  afterEach(async () => {
    await removeTempDir(scratch);
  });

  it("reads project commands, user commands, and skills", () => {
    const home = join(scratch, "home");
    const project = join(scratch, "project");
    mkdirSync(join(project, ".cursor", "commands"), { recursive: true });
    mkdirSync(join(home, ".cursor", "commands"), { recursive: true });
    mkdirSync(join(project, ".cursor", "skills", "review"), { recursive: true });
    writeFileSync(
      join(project, ".cursor", "commands", "ship-check.md"),
      `---
description: Verify the release checklist
argument-hint: version
---
ship`,
    );
    writeFileSync(join(home, ".cursor", "commands", "triage.md"), "# triage\n");
    writeFileSync(join(project, ".cursor", "skills", "review", "SKILL.md"), "---\ndescription: Review diff\n---\n");

    const catalog = discoverCursorCommandCatalog({ cwd: project, home });
    expect([...catalog.names].sort()).toEqual(["review", "ship-check", "triage"]);
    expect(catalog.byName.get("ship-check")?.description).toBe("Verify the release checklist");
  });
});

describe("buildCursorAgentAllowlist", () => {
  it("includes built-ins and dynamic rows for announced custom commands", () => {
    const allowlist = buildCursorAgentAllowlist(
      [...CURSOR_BUILTIN_COMMAND_NAMES, "ship-check"],
      { byName: new Map([["ship-check", { name: "ship-check", description: "Ship it" }]]) },
    );
    expect(allowlist.map((entry) => entry.name)).toContain("compress");
    expect(allowlist.find((entry) => entry.name === "ship-check")?.description).toBe("Ship it");
  });

  it("offers compress and custom commands when announced on Cursor 1.0.0", () => {
    const allowlist = buildCursorAgentAllowlist(["compress", "ship-check"], {
      byName: new Map([["ship-check", { name: "ship-check" }]]),
    });
    const offered = offeredEngineCommands("cursorAgent", ["compress", "ship-check"], "1.0.46 (Cursor)", {
      cursorAgent: allowlist,
    });
    expect(offered.map((entry) => entry.name)).toEqual(["compress", "ship-check"]);
    expect(CURSOR_AGENT_BUILTIN_COMMANDS.some((entry) => entry.name === "compress")).toBe(true);
  });
});
