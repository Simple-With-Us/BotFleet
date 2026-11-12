import { describe, expect, it } from "vitest";
import {
  conversationModeFailureCopy,
  simpleMergeConflictLabel,
  simpleMergeConflicts,
  simpleMergeRefusal,
  type SimpleMergeOwner,
  type TaskWorkspaceContext,
} from "./task-workspace-context.ts";

function context(id: string, cwd: string): TaskWorkspaceContext {
  return { kind: "local", appRef: { kind: "group", id }, cwd, capturedAt: 1 };
}

const inbox = { threadId: "inbox", title: "Inbox" };

describe("simpleMergeConflicts", () => {
  it("finds nothing to refuse when every extra conversation matches the open one", () => {
    const owners: SimpleMergeOwner[] = [{
      threadId: "inbox",
      tasks: [inbox, { threadId: "side", title: "Side work" }],
    }];
    expect(simpleMergeConflicts(owners)).toEqual([]);
  });

  it("names a conversation bound to a different App and leaves a matching one out", () => {
    const owners: SimpleMergeOwner[] = [{
      threadId: "inbox",
      tasks: [
        inbox,
        { threadId: "side", title: "Side work" },
        { threadId: "bound", title: "Release notes", workspaceContext: context("app-a", "/work/app") },
      ],
    }];
    expect(simpleMergeConflicts(owners)).toEqual([{
      threadId: "bound",
      title: "Release notes",
      reason: "is bound to an App",
    }]);
  });

  it("treats two Apps, and the same App in another folder, as separate conflicts", () => {
    const home = context("app-a", "/work/app");
    const owners: SimpleMergeOwner[] = [{
      threadId: "home",
      tasks: [
        { threadId: "home", title: "Home", workspaceContext: home },
        { threadId: "other-app", title: "Other app", workspaceContext: context("app-b", "/work/app") },
        { threadId: "other-folder", title: "Other folder", workspaceContext: context("app-a", "/work/elsewhere") },
      ],
    }];
    const conflicts = simpleMergeConflicts(owners);
    expect(conflicts.map((conflict) => conflict.threadId)).toEqual(["other-app", "other-folder"]);
    expect(simpleMergeConflictLabel(conflicts[0]!.reason)).toBe("different App");
    expect(simpleMergeConflictLabel(conflicts[1]!.reason)).toBe("different folder");
  });

  it("ignores a direct-message room", () => {
    const owners: SimpleMergeOwner[] = [{
      threadId: "dm",
      dm: true,
      tasks: [
        { threadId: "dm", title: "Chat" },
        { threadId: "bound", title: "Bound", workspaceContext: context("app-a", "/work/app") },
      ],
    }];
    expect(simpleMergeConflicts(owners)).toEqual([]);
  });
});

describe("simpleMergeRefusal", () => {
  it("names the conversation and says what to do, without a status code", () => {
    const text = simpleMergeRefusal([{
      threadId: "bound",
      title: "Release notes",
      reason: "is bound to an App",
    }]);
    expect(text).toContain("“Release notes”");
    expect(text).toContain("belongs to an App and the open conversation does not");
    expect(text).toContain("Nothing was merged, and the workspace stayed as it is.");
    expect(text).toContain("switch to Simple without combining them");
    expect(text).not.toMatch(/\b409\b/);
    expect(text).not.toContain("bindings");
    expect(text).toContain("\u00A0 ");
  });

  it("uses one clause when every conversation fails for the same reason", () => {
    const text = simpleMergeRefusal([
      { threadId: "a", title: "Alpha", reason: "belongs to another App" },
      { threadId: "b", title: "Beta", reason: "belongs to another App" },
    ]);
    expect(text.startsWith("“Alpha” and “Beta”")).toBe(true);
    expect(text).toContain("they belong to different Apps");
  });
});

describe("conversationModeFailureCopy", () => {
  it("shows the server sentence", () => {
    expect(conversationModeFailureCopy(409, "“Release notes” cannot be combined.")).toBe(
      "“Release notes” cannot be combined.",
    );
  });

  it("replaces a bare status line with a reason and a next step", () => {
    const text = conversationModeFailureCopy(409, "409 Conflict");
    expect(text).not.toMatch(/\b409\b/);
    expect(text).toContain("switch to Simple without combining them");
  });

  it("does not invent a merge explanation for a different failure", () => {
    expect(conversationModeFailureCopy(500, "")).toBe("That change could not be saved.\u00A0 Try again.");
  });
});
