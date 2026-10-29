// What the one-file animated avatar draws.
//
// The most important thing in this file is what it does NOT draw.  Every
// animated GIF and WebP avatar that exists today carries no manifest, and
// they all have to keep working exactly as they do, so the plain image path
// is the default and the player only takes over when the file proves it is
// an animated avatar.
//
// The markup is compared against the app's own image path rather than
// against a copy of it, so the two cannot drift apart without this failing.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotAvatar } from "../Avatar";
import { AnimatedFileAvatar } from "./AnimatedFileAvatar";

const SRC = "/api/attachments/1a2b3c4d.webp";

describe("the plain image path", () => {
  it("draws an ordinary image, not a canvas", () => {
    const html = renderToStaticMarkup(
      createElement(AnimatedFileAvatar, { src: SRC, alt: "Scout avatar", size: 44 }),
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("<canvas");
  });

  it("draws the same image the other crops draw", () => {
    // The animated crop hands its file to this component, so the image the
    // component draws has to be the image the app has always drawn.
    const animated = renderToStaticMarkup(
      createElement(AnimatedFileAvatar, {
        src: SRC,
        alt: "Scout avatar",
        size: 44,
        radius: "50%",
      }),
    );
    const circle = renderToStaticMarkup(
      createElement(BotAvatar, {
        bot: { name: "Scout", color: "green", avatarUrl: SRC, avatarCrop: "circle" },
        size: 44,
      }),
    );
    expect(animated).toBe(circle);
  });

  it("keeps the size, the name and the rounded corners of the crop", () => {
    const html = renderToStaticMarkup(
      createElement(AnimatedFileAvatar, {
        src: SRC,
        alt: "Scout avatar",
        size: 112,
        radius: "22%",
      }),
    );
    expect(html).toContain('width="112"');
    expect(html).toContain('height="112"');
    expect(html).toContain('alt="Scout avatar"');
    expect(html).toContain("border-radius:22%");
  });

  it("does not animate before the file has been read", () => {
    // The file is read in the background, and the avatar is on screen the
    // whole time.  A manifest that turns up a moment later upgrades the
    // picture; a file without one leaves it exactly as it was.
    const html = renderToStaticMarkup(
      createElement(AnimatedFileAvatar, { src: SRC, alt: "Scout avatar", size: 44 }),
    );
    expect(html).not.toContain("<canvas");
    expect(html).toContain("<img");
  });
});
