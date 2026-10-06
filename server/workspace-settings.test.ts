import { describe, expect, it } from "vitest";

import {
  allowsMultipleBotThreads,
  automationLaneTitle,
  parseConversationMode,
  roomRole,
} from "../shared/conversation-mode.ts";
import {
  ARRANGEMENT_PRESETS,
  DEFAULT_WORKSPACE_SETTINGS,
  effectiveWorkspaceSettings,
  HONORED_AXES,
  legacyAxesFor,
  resolveWorkspaceSettings,
  ROSTER_KINDS,
  conversationModeFor,
} from "../shared/workspace-settings.ts";

/** The guarantee this whole refactor rests on: an install that persists
 * nothing new behaves EXACTLY as it did before, for every helper the 88
 * existing call sites use. */
describe("workspace settings: the split is a no-op by default", () => {
  for (const mode of ["simple", "projects"] as const) {
    it(`resolves ${mode} to the axes that mode already implied`, () => {
      const settings = resolveWorkspaceSettings(undefined, mode);
      expect(settings).toEqual(legacyAxesFor(mode));
      expect(settings.fanOut !== "single").toBe(allowsMultipleBotThreads(mode));
      expect(roomRole(conversationModeFor(settings))).toBe(roomRole(mode));
      expect(
        automationLaneTitle(conversationModeFor(settings), "webhook"),
      ).toBe(automationLaneTitle(mode, "webhook"));
    });
  }

  it("reads the retired fleet draft as projects, on every axis", () => {
    const viaFleet = resolveWorkspaceSettings(undefined, parseConversationMode("fleet"));
    const viaProjects = resolveWorkspaceSettings(undefined, "projects");
    expect(viaFleet).toEqual(viaProjects);
  });

  it("defaults to the simple axes", () => {
    expect(DEFAULT_WORKSPACE_SETTINGS).toEqual(legacyAxesFor("simple"));
    expect(DEFAULT_WORKSPACE_SETTINGS).toEqual(ARRANGEMENT_PRESETS["bot-team"]);
  });
});

describe("workspace settings: axes fall back independently", () => {
  it("keeps today's other axes when only one is persisted", () => {
    const settings = resolveWorkspaceSettings({ fanOut: "single" }, "projects");
    expect(settings).toEqual({ roster: "threads", fanOut: "single", workspace: "shared-cwd" });
  });

  it("ignores unknown values instead of adopting them", () => {
    const settings = resolveWorkspaceSettings(
      { roster: "nonsense", fanOut: "parallel", workspace: "cloud" },
      "projects",
    );
    expect(settings).toEqual(legacyAxesFor("projects"));
  });

  it("survives a null record", () => {
    expect(resolveWorkspaceSettings(null, "simple")).toEqual(legacyAxesFor("simple"));
  });
});

describe("workspace settings: the runtime does not honour every axis yet", () => {
  it("clamps the workspace axis until worktree leases ship", () => {
    expect(HONORED_AXES.workspace).toBe(false);
    const requested = resolveWorkspaceSettings({ workspace: "worktree-per-task" }, "simple");
    expect(requested.workspace).toBe("worktree-per-task");
    // The request is recorded, but the effective value never over-promises.
    expect(effectiveWorkspaceSettings(requested).workspace).toBe("shared-cwd");
  });

  it("leaves the honoured axes alone", () => {
    const settings = { roster: "threads", fanOut: "per-room", workspace: "shared-cwd" } as const;
    expect(effectiveWorkspaceSettings(settings)).toEqual(settings);
  });
});

describe("workspace settings: arrangement presets", () => {
  it("keeps app-teams honest about concurrency", () => {
    // C is organization only.  It must never imply that a bot holds two apps
    // at once, which the runtime cannot yet do.
    expect(ARRANGEMENT_PRESETS["app-teams"].fanOut).toBe("per-room");
    expect(ARRANGEMENT_PRESETS["app-teams"].roster).toBe("bots");
  });

  it("only ever uses roster kinds the sidebar can paint", () => {
    for (const preset of Object.values(ARRANGEMENT_PRESETS)) {
      expect(ROSTER_KINDS).toContain(preset.roster);
    }
  });
});
