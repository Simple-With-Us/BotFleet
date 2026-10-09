// What the Review Routine Approvals card draws.  The words come from
// `autoReviewGate`; this pins that the card shows them, names the reviewer,
// greys out only what is really unavailable, and offers the fallback picker,
// Automatic by default, so review works without anyone picking a reviewer.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutoReviewCardView } from "./AutoReviewCard";
import { autoReviewGate } from "@/lib/bot-settings-gates";
import type { InstanceInfo } from "@/state/store";

const engine = (
  instanceId: string,
  displayName: string,
  capabilities: NonNullable<InstanceInfo["capabilities"]>,
): InstanceInfo => ({
  instanceId,
  driverKind: instanceId,
  displayName,
  snapshot: { state: "available" },
  models: { default: "m", options: [] },
  capabilities: { computerMcp: false, agentsMcp: false, localComputerMcp: false, toolLoop: false, ...capabilities },
});

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
  });

  it("works for an engine that cannot review itself without anyone picking a reviewer, and says who was picked", () => {
    const automatic = render("cursor", null);
    expect(automatic).toContain("Reviewer: </span>Claude Code (fallback reviewer, picked automatically)");
    expect(automatic).toContain('<option value="" selected="">Automatic (Claude Code)</option>');
    expect(disabledButtons(automatic)).toEqual([]);

    const chosen = render("cursor", "claude");
    expect(chosen).toContain("Reviewer: </span>Claude Code (fallback reviewer)");
    expect(chosen).toContain('<option value="claude" selected="">Claude Code</option>');

    const off = render("cursor", "none");
    expect(off).toContain('<option value="none" selected="">None</option>');
    expect(disabledButtons(off)).toEqual(["Watch", "On"]);
  });

  it("tells an engine with no hook that review can only watch", () => {
    const html = render("agy", "claude", { autoReview: "enforce" });
    expect(html).toContain("can only watch");
    expect(html).toContain('title="Stop the turn when the reviewer refuses a step or cannot check it."');
  });

  it("shows the Bypass Permissions rule beside the mode", () => {
    const html = render("claude", null, { bypassPermissions: true, autoReview: "enforce" });
    expect(html).toContain("the reviewer still checks each approval first");
  });

  it("shows the per-turn review limit while review is on", () => {
    expect(render("claude", null, { autoReview: "shadow" })).toContain("Up to 50 reviews per turn.");
    expect(render("claude", null)).not.toContain("reviews per turn");
  });

  it("keeps a saved reviewer visible when it is no longer available", () => {
    const html = render("cursor", "gone");
    expect(html).toContain('<option value="gone" selected="">gone (unavailable)</option>');
  });
});
