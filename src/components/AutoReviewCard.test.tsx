// What the Review Routine Approvals card draws.  The words come from
// `autoReviewGate`; this pins that the card shows them, names the reviewer,
// greys out only what is really unavailable, and offers the fallback picker
// to an engine that cannot review on its own.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutoReviewCardView } from "./AutoReviewCard";
import { autoReviewGate } from "@/lib/bot-settings-gates";
import type { InstanceInfo } from "@/state/store";

const engine = (instanceId: string, displayName: string, capabilities: Record<string, unknown>): InstanceInfo =>
  ({
    instanceId,
    driverKind: instanceId,
    displayName,
    capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false, toolLoop: false, ...capabilities },
  }) as InstanceInfo;

const CLAUDE = engine("claude", "Claude Code", { approvalReview: true, reviewHook: "before", asksWhenHeld: true });
const CURSOR = engine("cursor", "Cursor", { reviewHook: "before", asksWhenHeld: true });
const AGY = engine("agy", "Antigravity", { reviewHook: "after" });
const INSTANCES = [CLAUDE, CURSOR, AGY];

function render(instanceId: string, fallback: string | null, patch: { bypassPermissions?: boolean; autoReview?: "off" | "shadow" | "enforce" } = {}) {
  const bot = { modelSelection: { instanceId, model: "m" }, ...patch };
  const gate = autoReviewGate(INSTANCES, bot, fallback);
  return renderToStaticMarkup(
    createElement(AutoReviewCardView, {
      mode: patch.autoReview ?? "off",
      gate,
      fallbackReviewer: fallback,
      onMode: () => {},
      onFallbackReviewer: () => {},
    }),
  );
}

const disabledButtons = (html: string) =>
  [...html.matchAll(/<button[^>]*disabled=""[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);

describe("AutoReviewCardView", () => {
  it("no longer says the engine cannot run a review, and names the engine that reviews itself", () => {
    const html = render("claude", null);
    expect(html).not.toContain("cannot run an isolated review safely");
    expect(html).toContain("Reviewer: </span>Claude Code (this engine)");
    expect(disabledButtons(html)).toEqual([]);
    expect(html).not.toContain("Fallback Reviewer");
  });

  it("offers the fallback picker to an engine that cannot review itself, and enables review once one is chosen", () => {
    const before = render("cursor", null);
    expect(before).toContain("Fallback Reviewer");
    expect(before).toContain('<option value="claude">Claude Code</option>');
    expect(disabledButtons(before)).toEqual(["Watch", "On"]);

    const after = render("cursor", "claude");
    expect(after).toContain("Reviewer: </span>Claude Code (fallback reviewer)");
    expect(disabledButtons(after)).toEqual([]);
  });

  it("tells an engine with no hook that review can only watch", () => {
    const html = render("agy", "claude", { autoReview: "enforce" });
    expect(html).toContain("can only watch");
    expect(html).toContain('title="Stop the turn when the reviewer refuses a step."');
  });

  it("shows the Bypass Permissions rule beside the mode", () => {
    const html = render("claude", null, { bypassPermissions: true, autoReview: "enforce" });
    expect(html).toContain("the reviewer still checks each action first");
  });

  it("keeps a saved reviewer visible when it is no longer available", () => {
    const html = render("cursor", "gone");
    expect(html).toContain('<option value="gone" selected="">gone (unavailable)</option>');
  });
});
