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

/** Retired mac-collab board surfaces agents must not treat as live. */
const RETIRED_BOARD_PATTERNS = [
  /mac\.jays\.services\/board/,
  /MAC_COLLAB_TOKEN/,
  /apps\/mac-collab/,
  /mac-collab-writeback/,
  /mac-collab-sync/,
  /<APP>\s+<board8>/i,
  /mirror before every push/i,
] as const;

const SHARED_LINEAR_MARKER = "Linear-backed board CLI";

describe("agent docs point at Linear, not mac-collab board", () => {
  for (const rel of AGENT_DOC_PATHS) {
    const text = readFileSync(join(repoRoot, rel), "utf8");
    const label = rel;

    it(`${label} has no retired mac-collab board references`, () => {
      for (const pattern of RETIRED_BOARD_PATTERNS) {
        expect(text, `${label} matched ${pattern}`).not.toMatch(pattern);
      }
    });
  }

  it("AGENTS.md names Linear team BF and the board CLI", () => {
    const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toContain("--team BF");
    expect(agents).toContain("linear.app/simple-with-us/team/BF");
    expect(agents).not.toMatch(/mac-collab/);
  });

  it("composed seat prompt still advertises the Linear-backed board CLI", () => {
    const shared = readFileSync(join(repoRoot, "bots/_shared.md"), "utf8");
    expect(shared).toContain(SHARED_LINEAR_MARKER);
  });
});
