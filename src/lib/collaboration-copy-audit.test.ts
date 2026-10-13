import { describe, expect, it } from "vitest";

import { convertSlackReferenceToZulip, hasSlackReference } from "./collaboration-copy-audit";

describe("collaboration copy audit", () => {
  it("finds Slack in saved names, prompts, and retired helper names", () => {
    expect(hasSlackReference("Daily review", "Post to Slack #agent-sync")).toBe(true);
    expect(hasSlackReference("Run slack-sync inbox")).toBe(true);
    expect(hasSlackReference("Post to Zulip #agent-sync")).toBe(false);
  });

  it("converts only after the user chooses Zulip", () => {
    expect(convertSlackReferenceToZulip("Run slack-collab, then post to Slack at slack.com."))
      .toBe("Run agent-sync, then post to Zulip at simplewithus.zulipchat.com.");
    expect(convertSlackReferenceToZulip("Keep SLACK_BOT_TOKEN secret."))
      .toBe("Keep SLACK_BOT_TOKEN secret.");
  });
});
