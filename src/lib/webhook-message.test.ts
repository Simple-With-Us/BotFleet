import { describe, expect, it } from "vitest";

import { webhookMessageView } from "./webhook-message";

describe("webhookMessageView", () => {
  it("presents an authenticated webhook task without its trust wrappers", () => {
    const text = [
      "[AUTHENTICATED WEBHOOK TASK]",
      "Summarize the failed deploy and suggest the first check.",
      "[/AUTHENTICATED WEBHOOK TASK]",
      "",
      "[UNTRUSTED WEBHOOK EVENT DATA]",
      "Received: 2026-08-16T12:47:58.969Z",
      "Delivery ID: deploy-418",
      "Event: deployment.failed",
      "",
      JSON.stringify({ task: "Summarize the failed deploy and suggest the first check.", service: "checkout-api", environment: "production" }, null, 2),
      "[/UNTRUSTED WEBHOOK EVENT DATA]",
    ].join("\n");

    expect(webhookMessageView(text)).toEqual({
      task: "Summarize the failed deploy and suggest the first check.",
      payload: JSON.stringify({ task: "Summarize the failed deploy and suggest the first check.", service: "checkout-api", environment: "production" }, null, 2),
      event: "deployment.failed",
      headline: "deployment.failed",
      subtitle: undefined,
    });
  });

  it("supports configured instructions and leaves normal chat messages alone", () => {
    const webhook = "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]\nTriage every build failure.\n[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nEvent: build.failed\n\nraw payload\n[/UNTRUSTED WEBHOOK EVENT DATA]";
    expect(webhookMessageView(webhook)).toMatchObject({
      task: "Triage every build failure.",
      payload: "raw payload",
      event: "build.failed",
      headline: "build.failed",
    });
    expect(webhookMessageView("hello from a person")).toBeNull();
  });

  it("uses the Sentry issue title as the card headline, not the bot instructions", () => {
    const payload = JSON.stringify({
      action: "unresolved",
      data: {
        issue: {
          title: "Cron failure: ci-usage-monitor-ci",
          project: { slug: "fleet-infra" },
        },
      },
    });
    const text = [
      "[USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
      "You are BF-Fixer. A Sentry webhook fired.",
      "[/USER-CONFIGURED WEBHOOK INSTRUCTIONS]",
      "",
      "[UNTRUSTED WEBHOOK EVENT DATA]",
      "Event: issue",
      "",
      payload,
      "[/UNTRUSTED WEBHOOK EVENT DATA]",
    ].join("\n");

    expect(webhookMessageView(text)).toMatchObject({
      headline: "Cron failure: ci-usage-monitor-ci",
      project: "fleet-infra",
      event: "issue",
      subtitle: "fleet-infra · issue",
    });
  });
});
