import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  IMPORT_BUTTON_LABEL,
  OPEN_SKILL_LABEL,
  SKILLS_EMPTY_COPY,
  SKILLS_PANEL_DESCRIPTION,
  SKILLS_PANEL_TITLE,
  SkillRow,
  skillRowView,
  skillsEngineNote,
  skillsNotIndexedNotice,
  skillsPanelPlaceholder,
  type SkillListingRow,
} from "./BotSkillsPanel";
import type { Bot } from "@/state/store";

// SAFETY: SkillRow reads exactly one field of Bot — `bot.id`, to build the
// skill route — so a stub with that field is the whole contract it needs.
const bot = { id: "bot-1" } as Bot;

const skill = (patch: Partial<SkillListingRow> = {}): SkillListingRow => ({
  name: "code-review",
  description: "Reviews a PR the way this team reviews PRs.",
  enabled: false,
  source: "github.com/example/skills/code-review",
  sha256: "0".repeat(64),
  importedAt: "2026-09-16T18:30:00.000Z",
  warnings: [],
  skippedFiles: [],
  ...patch,
});

const render = (row: SkillListingRow) =>
  renderToStaticMarkup(
    createElement(SkillRow, { bot, skill: row, onChanged: () => {}, onError: () => {} }),
  );

describe("no skills imported", () => {
  it("says what to do instead of showing an empty list", () => {
    expect(skillsPanelPlaceholder([], false, null)).toBe(SKILLS_EMPTY_COPY);
    expect(SKILLS_EMPTY_COPY).toContain("No skills imported yet.");
    // the S4 promise, in the panel's own copy: imports land disabled
    expect(SKILLS_PANEL_DESCRIPTION).toContain("starts disabled");
    expect(SKILLS_EMPTY_COPY).toContain("Only markdown is imported");
  });

  it("never answers a failed or unfinished load with “no skills”", () => {
    expect(skillsPanelPlaceholder([], true, null)).toBe("Loading…");
    // a failed load yields to the error banner rather than claiming nothing
    // is imported, and a failed toggle never blanks a list that loaded fine
    expect(skillsPanelPlaceholder([], false, "the server said no")).toBeNull();
    expect(skillsPanelPlaceholder([skill()], false, "enable failed")).toBeNull();
    expect(skillsPanelPlaceholder([skill()], false, null)).toBeNull();
  });
});

describe("an installed, disabled skill with scan warnings", () => {
  const warned = skill({
    warnings: [
      "contains invisible Unicode characters (zero-width or bidi controls) — text you cannot see",
    ],
    skippedFiles: ["install.sh", "scripts"],
  });

  it("shows the warnings, the skipped files, and the provenance", () => {
    const markup = render(warned);
    expect(markup).toContain("Before you enable this");
    expect(markup).toContain("invisible Unicode characters");
    expect(markup).toContain("Not imported: install.sh, scripts.");
    expect(markup).toContain("Imported from github.com/example/skills/code-review");
    expect(markup).toContain(OPEN_SKILL_LABEL);
  });

  it("offers Enable, disabled, and says why", () => {
    const view = skillRowView(warned, false);
    expect(view.actionLabel).toBe("Enable");
    expect(view.actionDisabled).toBe(true);
    expect(view.gateReason).toContain("Open the SKILL.md first.");
    expect(view.status).toBe("Disabled — nothing in this skill reaches this bot yet.");
    expect(render(warned)).toContain("disabled=\"\"");
  });
});

describe("an enabled skill", () => {
  const on = skill({ enabled: true });

  it("says it is in use and offers Disable, never gated", () => {
    const view = skillRowView(on, false);
    expect(view.actionLabel).toBe("Disable");
    expect(view.actionDisabled).toBe(false);
    expect(view.gateReason).toBeNull();
    expect(view.status).toContain("Enabled —");
    expect(view.warningsHeading).toBeNull();
    expect(view.skippedNote).toBeNull();

    const markup = render(on);
    expect(markup).toContain("Disable");
    expect(markup).not.toContain("disabled=\"\"");
    expect(markup).not.toContain("Before you enable this");
  });
});

describe("the read-then-enable gate", () => {
  // server/skills.ts states the policy this enforces: an import lands
  // DISABLED, the UI shows the SKILL.md, and a person enables after
  // reading.  Enabling before the text has been opened would make that
  // sentence false.
  it("keeps Enable disabled until the SKILL.md has been opened", () => {
    const pending = skill();
    expect(skillRowView(pending, false).actionDisabled).toBe(true);
    expect(skillRowView(pending, true).actionDisabled).toBe(false);
    expect(skillRowView(pending, true).gateReason).toBeNull();
  });

  it("keeps the control disabled while a toggle is in flight, whatever the gate says", () => {
    expect(skillRowView(skill(), true, true)).toMatchObject({ actionLabel: "Working…", actionDisabled: true });
    expect(skillRowView(skill({ enabled: true }), true, true).actionDisabled).toBe(true);
  });
});

describe("panel chrome", () => {
  it("uses Title Case for the heading and the button, sentence case for status", () => {
    expect(SKILLS_PANEL_TITLE).toBe("Skills");
    expect(IMPORT_BUTTON_LABEL).toBe("Import Skill Folder…");
    expect(OPEN_SKILL_LABEL).toBe("Open SKILL.md");
    expect(skillRowView(skill(), true).status.startsWith("Disabled")).toBe(true);
  });

  it("separates sentences with a gap that survives HTML collapsing", () => {
    for (const copy of [SKILLS_PANEL_DESCRIPTION, SKILLS_EMPTY_COPY, skillRowView(skill(), false).gateReason!]) {
      for (const match of copy.matchAll(/[.;] +[A-Z]/g)) {
        throw new Error(`plain space between sentences (will collapse): ${JSON.stringify(match[0])}`);
      }
      expect(copy).toContain("  ");
    }
  });

  it("tells the truth about the Computer engine, which has no workspace to hold a skill", () => {
    expect(skillsEngineNote("claudeAgent")).toBeNull();
    expect(skillsEngineNote(undefined)).toBeNull();
    const note = skillsEngineNote("boxAgent");
    expect(note).toContain("runs on the Computer engine");
    expect(note).toContain("Imported skills never reach it.");
    expect(note).toContain("  ");
  });
});

describe("skillsNotIndexedNotice (Finding 2: the index cap no longer drops silently)", () => {
  it("says nothing when every enabled skill made the index", () => {
    expect(skillsNotIndexedNotice(undefined)).toBeNull();
    expect(skillsNotIndexedNotice([])).toBeNull();
  });

  it("names the count and every left-out skill, singular and plural", () => {
    const one = skillsNotIndexedNotice(["zeta-writer"]);
    expect(one).toContain("1 enabled skill not indexed");
    expect(one).toContain("zeta-writer");
    expect(one).not.toContain("skills not indexed");

    const many = skillsNotIndexedNotice(["zeta-writer", "zulu-reviewer"]);
    expect(many).toContain("2 enabled skills not indexed");
    expect(many).toContain("zeta-writer");
    expect(many).toContain("zulu-reviewer");
  });

  it("separates sentences with a gap that survives HTML collapsing", () => {
    for (const match of skillsNotIndexedNotice(["x"])!.matchAll(/[.;] +[A-Z]/g)) {
      throw new Error(`plain space between sentences (will collapse): ${JSON.stringify(match[0])}`);
    }
  });
});
