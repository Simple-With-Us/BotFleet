/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

const AGENT_DOC_PATHS = [
  "AGENTS.md",
  "bots/_shared.md",
  ".claude/skills/board-ops/SKILL.md",
  ".claude/skills/session-start/SKILL.md",
  ".claude/skills/closeout/SKILL.md",
  ".claude/skills/pickup-seat/SKILL.md",
  ".claude/skills/land-lane/SKILL.md",
  ".claude/skills/fleet-coordination/SKILL.md",
] as const;

/** Paths that may mention mac-collab only as a PATH-shadow warning or archive note. */
const MAC_COLLAB_WARNING_ALLOWLIST = new Set<string>([
  "AGENTS.md",
  "bots/_shared.md",
  ".claude/skills/board-ops/SKILL.md",
  ".claude/skills/session-start/SKILL.md",
]);

/** Paths that may name MAC_COLLAB_TOKEN only in a “do not paste” warning. */
const MAC_COLLAB_TOKEN_ALLOWLIST = new Set<string>([
  ".claude/skills/board-ops/SKILL.md",
]);

/** Retired mac-collab board surfaces agents must not treat as live. */
const RETIRED_BOARD_PATTERNS = [
  /mac-collab-writeback/,
  /mac-collab-sync/,
  /<APP>\s+<board8>/i,
  /mirror before every push/i,
  /export PATH="\$HOME\/apps\/mac-collab/,
] as const;

const MAC_COLLAB_PATH_PATTERN = /apps\/mac-collab/;

const SHARED_LINEAR_MARKER = "Linear-backed board CLI";

describe("agent docs point at Linear, not mac-collab board", () => {
  for (const rel of AGENT_DOC_PATHS) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    const label = rel;

    it(`${label} has no retired mac-collab board references`, () => {
      for (const pattern of RETIRED_BOARD_PATTERNS) {
        expect(text, `${label} matched ${pattern}`).not.toMatch(pattern);
      }
      if (!MAC_COLLAB_TOKEN_ALLOWLIST.has(rel) && /MAC_COLLAB_TOKEN/.test(text)) {
        expect.fail(`${label} must not mention MAC_COLLAB_TOKEN`);
      }
      if (!MAC_COLLAB_WARNING_ALLOWLIST.has(rel) && MAC_COLLAB_PATH_PATTERN.test(text)) {
        expect.fail(`${label} must not mention apps/mac-collab outside the PATH-shadow warning`);
      }
    });
  }

  it("AGENTS.md names team BF and forbids mac-collab PATH shadowing", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/team \*\*BF\*\*/);
    expect(agents).toContain("Never prepend");
    expect(agents).toContain("~/.local/bin/board");
    expect(agents).not.toMatch(/MAC_COLLAB_TOKEN/);
  });

  it("composed seat prompt still advertises the Linear-backed board CLI", () => {
    const shared = readFileSync(join(repoRoot, "bots/_shared.md"), "utf8");
    expect(shared).toContain(SHARED_LINEAR_MARKER);
  });
});
