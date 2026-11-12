import { describe, expect, it } from "vitest";

import {
  FROM_IMESSAGE_TAG,
  imessageMessageView,
  isImessageInboundSource,
  outboundImessageText,
  parseImessageInbound,
  stripToImessagePrefix,
  wrapImessageInbound,
} from "./imessage-message";

describe("imessage inbound wrap", () => {
  it("wraps a raw iMessage so the model sees [from iMessage]", () => {
    const wrapped = wrapImessageInbound("What's the deploy status?");
    expect(wrapped).toContain(FROM_IMESSAGE_TAG);
    expect(wrapped).toContain("[IMESSAGE INBOUND]");
    expect(wrapped).toContain("What's the deploy status?");
    expect(parseImessageInbound(wrapped)?.body).toBe("What's the deploy status?");
  });

  it("is idempotent when the inbound is already wrapped or prefixed", () => {
    const once = wrapImessageInbound("hello from phone");
    expect(wrapImessageInbound(once)).toBe(once);
    const prefixed = wrapImessageInbound("[from iMessage] already tagged");
    expect(parseImessageInbound(prefixed)?.body).toBe("already tagged");
  });

  it("cards the first line and leaves ordinary chat alone", () => {
    const view = imessageMessageView(wrapImessageInbound("Need a summary\nMore context here"));
    expect(view).toMatchObject({
      headline: "Need a summary",
      subtitle: "iMessage",
      payload: "More context here",
    });
    expect(imessageMessageView("hello from a person")).toBeNull();
    expect(imessageMessageView("[from iMessage] short ping")).toMatchObject({
      headline: "short ping",
      subtitle: "iMessage",
      payload: undefined,
    });
  });

  it("treats source=imessage and the relay user-agent as inbound", () => {
    expect(isImessageInboundSource("imessage")).toBe(true);
    expect(isImessageInboundSource("IMESSAGE")).toBe(true);
    expect(isImessageInboundSource(undefined, "BotFleet-Relay")).toBe(true);
    expect(isImessageInboundSource(undefined, "Mozilla/5.0")).toBe(false);
    expect(isImessageInboundSource("web")).toBe(false);
  });
});

describe("imessage outbound gate", () => {
  it("strips [to iMessage] and ignores untagged bot text", () => {
    expect(stripToImessagePrefix("[to iMessage]\nShip it.")).toBe("Ship it.");
    expect(stripToImessagePrefix("[to iMessage] Ship it.")).toBe("Ship it.");
    expect(stripToImessagePrefix("[TO IMESSAGE] Ship it.")).toBe("Ship it.");
    expect(outboundImessageText("Working on the deploy in BotFleet.")).toBeNull();
    expect(outboundImessageText("[to iMessage]   ")).toBeNull();
    expect(outboundImessageText("[to iMessage] Yes, that is done.")).toBe("Yes, that is done.");
  });
});
