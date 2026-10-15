import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  discoverStaticEngineCommands,
  mergeAnnouncedEngineCommands,
} from "./engine-command-discovery.ts";

describe("discoverStaticEngineCommands", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "omb-engine-cmd-disc-"));
  });

  afterEach(async () => {
    await removeTempDir(scratch);
  });

  it("reads Claude project and user command markdown files", () => {
    const home = join(scratch, "home");
    const project = join(scratch, "project");
    mkdirSync(join(project, ".claude", "commands"), { recursive: true });
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(join(project, ".claude", "commands", "review.md"), "# review\n");
    writeFileSync(join(home, ".claude", "commands", "security-review.md"), "# sec\n");

    const names = discoverStaticEngineCommands("claudeAgent", {
      cwd: project,
      home,
      env: { CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    expect(names).toEqual(["review", "security-review"]);
  });

  it("reads Codex prompt files under CODEX_HOME and the project tree", () => {
    const home = join(scratch, "home");
    const project = join(scratch, "repo");
    mkdirSync(join(project, ".codex", "prompts"), { recursive: true });
    mkdirSync(join(home, ".codex", "prompts"), { recursive: true });
    writeFileSync(join(project, ".codex", "prompts", "ship.md"), "ship it");
    writeFileSync(join(home, ".codex", "prompts", "triage.md"), "triage");

    expect(
      discoverStaticEngineCommands("codex", {
        cwd: project,
        home,
        env: { CODEX_HOME: join(home, ".codex") },
      }),
    ).toEqual(["ship", "triage"]);
  });

  it("returns nothing for engines without a static scanner", () => {
    expect(discoverStaticEngineCommands("minimax", { cwd: scratch, home: scratch })).toEqual([]);
  });
});

describe("mergeAnnouncedEngineCommands", () => {
  it("dedupes cache and discovery", () => {
    expect(mergeAnnouncedEngineCommands(["compact", "context"], ["context", "review"])).toEqual([
      "compact",
      "context",
      "review",
    ]);
  });

  it("returns null when both sides are empty", () => {
    expect(mergeAnnouncedEngineCommands(null, [])).toBeNull();
  });
});
