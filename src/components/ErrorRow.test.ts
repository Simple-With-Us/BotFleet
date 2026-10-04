import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ErrorRow,
  TurnErrorAnnouncement,
  advanceTurnErrorLiveState,
  formatSentenceGap,
  isComputerDispatchError,
  isProviderError,
  latestTurnErrorMessage,
  nextTurnErrorAnnouncement,
  turnErrorBranchKey,
} from "./ErrorRow";

describe("ErrorRow recovery", () => {
  it("classifies computer-dispatch failures before generic model copy", () => {
    expect(isComputerDispatchError("computer tool failed: no desktop")).toBe(true);
    expect(isComputerDispatchError("this bot has no computer yet — open the Computer panel and provision one")).toBe(
      true,
    );
    expect(isComputerDispatchError("The Local VM desktop failed to start: x")).toBe(true);
    expect(isProviderError("rate limit from the provider")).toBe(true);
    expect(isProviderError("missing api key")).toBe(true);
  });

  it("offers computer recovery actions instead of a Retry-only card", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "computer tool failed: no desktop",
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Retry");
    expect(html).toContain("Open Computer");
    expect(html).toContain("Use This Computer");
    expect(html).toContain("Create Local VM");
  });

  it("keeps Switch Model and Add API Key on provider failures", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "provider 401: invalid api key",
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Retry With Fallback");
    expect(html).toContain("Switch Model");
    expect(html).toContain("Add API Key");
  });

  it("keeps historical failure rows out of assertive live regions", () => {
    const html = renderToStaticMarkup(createElement(ErrorRow, { message: "The task failed." }));

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-live="assertive"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("The task failed.");
  });

  it("announces only an error that arrives after the live region mounts", () => {
    const historical = { id: "old", kind: "activity", tool: { name: "error: old failure" } };
    const initialHtml = renderToStaticMarkup(createElement(TurnErrorAnnouncement, { latestMessage: historical }));
    const initial = nextTurnErrorAnnouncement("old\0old failure", historical);
    const fresh = nextTurnErrorAnnouncement(initial.signature, {
      id: "new",
      kind: "activity",
      tool: { name: "error: new failure" },
    });

    expect(initialHtml).toContain('role="alert"');
    expect(initialHtml).toContain('aria-live="assertive"');
    expect(initialHtml).toContain('aria-atomic="true"');
    expect(initialHtml).not.toContain("old failure");
    expect(initial.text).toBeNull();
    expect(fresh.text).toBe("new failure");
  });

  it("finds a new server error behind an optimistic queued message", () => {
    const error = { id: "error", kind: "activity", tool: { name: "error: provider failed" } };
    const queued = { id: "queued", kind: "text" };

    expect(latestTurnErrorMessage([error, queued])).toBe(error);
  });

  it("does not announce a historical error prepended behind an unchanged stream tail", () => {
    const historical = { id: "old-error", kind: "activity", tool: { name: "error: old failure" } };
    const next = nextTurnErrorAnnouncement("", historical, {
      previousTailId: "current-tail",
      currentTailId: "current-tail",
    });

    expect(next.signature).toBe("old-error\0old failure");
    expect(next.text).toBeNull();
  });

  it("announces the newest error when a later notice arrives in the same batch", () => {
    const error = { id: "new-error", kind: "activity", tool: { name: "error: provider failed" } };
    const next = nextTurnErrorAnnouncement("", latestTurnErrorMessage([error, { id: "notice", kind: "activity" }]), {
      previousTailId: "previous-tail",
      currentTailId: "notice",
    });

    expect(next.text).toBe("provider failed");
  });

  it("changes the alert baseline for a fork switch but not a linear append", () => {
    const root = { id: "root", role: "user", kind: "text", parentId: null };
    const first = { id: "first", role: "user", kind: "text", parentId: "root" };
    const second = { id: "second", role: "user", kind: "text", parentId: "root" };
    const reply = { id: "reply", role: "bot", kind: "text", parentId: "first" };
    const appended = { id: "appended", role: "bot", kind: "text", parentId: "reply" };
    const all = [root, first, second, reply, appended];

    expect(turnErrorBranchKey(all, [root, first, reply])).toBe("first");
    expect(turnErrorBranchKey(all, [root, first, reply, appended])).toBe("first");
    expect(turnErrorBranchKey(all, [root, second])).toBe("second");
  });

  it("changes the live-region node revision when consecutive failures have identical text", () => {
    const first = advanceTurnErrorLiveState({ text: "", nonce: 0 }, "authentication failed");
    const second = advanceTurnErrorLiveState(first, "authentication failed");

    expect(second.text).toBe(first.text);
    expect(second.nonce).toBe(first.nonce + 1);
  });

  it("offers Report Problem on turn error rows", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "Antigravity: authentication failed or timed out",
        onRetry: () => {},
      }),
    );
    expect(html).toContain("Retry");
    expect(html).toContain("Report Problem");

    const checkpointHtml = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "git checkpoint missing for task",
        onRetry: () => {},
      }),
    );
    expect(checkpointHtml).toContain("git fetch origin &amp;&amp; git checkout main");
    expect(checkpointHtml).toContain("Report Problem");
  });

  it("offers Report Problem on engine setup error rows", () => {
    const unavailableInstance = {
      instanceId: "kimi",
      driverKind: "kimiAgent",
      displayName: "Kimi",
      snapshot: { state: "unavailable" as const, reason: "`kimi` CLI not found" },
      models: { default: "kimi-code/k3", options: [] },
      install: {
        command: { darwin: "curl -fsSL https://kimi.ai/install.sh | bash" },
      },
    };
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "`kimi` CLI not found",
        setupInstance: unavailableInstance,
      }),
    );
    expect(html).toContain("Report Problem");
    expect(html).toContain("Install Kimi");
  });

  it("formats sentences with two visible spaces in rendered copy", () => {
    expect(formatSentenceGap("Error occurred. Please try again.")).toBe("Error occurred.\u00A0 Please try again.");
    expect(formatSentenceGap("Single sentence.")).toBe("Single sentence.");
    const html = renderToStaticMarkup(
      createElement(ErrorRow, {
        message: "The task failed. Please retry.",
      }),
    );
    expect(html).toContain("The task failed.\u00A0 Please retry.");
  });
});
