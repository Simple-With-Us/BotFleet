// SSR test for the avatar card.  Clicks go through patchForCrop, which is
// tested directly, so this file needs no browser.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { BotProfileAvatarCard, patchForCrop } from "./BotProfileAvatarCard.tsx";

function render(over: Partial<Bot>): string {
  // SAFETY: the card reads only the identity, color and avatar fields set here.
  const bot = { id: "bot-1", name: "Synthetic", color: "blue", ...over } as Bot;
  return renderToStaticMarkup(
    createElement(BotProfileAvatarCard, { bot, activeState: "idle", mascotMotion: null, onPatch: () => undefined }),
  );
}

describe("BotProfileAvatarCard", () => {
  it("offers no expression picker on either crop that used to have one", () => {
    const crops: NonNullable<Bot["avatarCrop"]>[] = ["mascot", "tvface"];
    for (const avatarCrop of crops) {
      const html = render({ avatarCrop });
      expect(html).not.toContain("expression\"");
      expect(html).not.toContain(">Expression<");
      expect(html).toContain(">Color<");
    }
  });

  it("shows no Color row on the animated crop, which draws no color", () => {
    const html = render({ avatarCrop: "animated", avatarUrl: "/api/avatar/synthetic.webp", recolorable: "shell" });
    expect(html).not.toContain(">Color<");
  });

  it("keeps the sentence gap in its help text", () => {
    expect(render({})).toContain("Drop an image onto the avatar.\u00a0 PNG");
  });
});

describe("patchForCrop", () => {
  it("keeps the bot's color when switching to TV-Face and clears a pinned expression", () => {
    expect(patchForCrop("tvface", "blue")).toEqual({ avatarCrop: "tvface", mascotExpression: null, color: "blue" });
  });

  it("falls back to orange only when the bot has no color", () => {
    expect(patchForCrop("tvface", undefined).color).toBe("orange");
  });

  it("leaves color alone on every other crop", () => {
    expect(patchForCrop("mascot", "blue")).toEqual({ avatarCrop: "mascot", mascotExpression: null });
    expect(patchForCrop("circle", "blue")).toEqual({ avatarCrop: "circle" });
  });
});
