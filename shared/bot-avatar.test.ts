import { describe, expect, it } from "vitest";

import {
  botAvatarRecolorableSchema,
  isAvatarRecolorable,
  normalizeAvatarRecolorable,
  avatarCropAfterUpload,
  BOT_AVATAR_CROPS,
  GROUP_AVATAR_CROPS,
} from "./bot-avatar";

describe("avatarCropAfterUpload", () => {
  it("flips image-less crops to circle so the upload actually displays", () => {
    // Mascot and TV-Face renderers ignore avatarUrl: keeping them after an
    // upload saves an image nothing shows (the #695 review finding).
    expect(avatarCropAfterUpload("mascot")).toBe("circle");
    expect(avatarCropAfterUpload("tvface")).toBe("circle");
  });

  it("flips the animated crop to circle when the upload carries no manifest", () => {
    // An animated avatar only plays if the file it points at carries a
    // manifest, so a plain image uploaded over one has to leave that crop.
    // The client puts the crop back when the file it just uploaded does
    // carry one.
    expect(avatarCropAfterUpload("animated")).toBe("circle");
  });

  it("keeps the person's chosen image crop", () => {
    expect(avatarCropAfterUpload("circle")).toBe("circle");
    expect(avatarCropAfterUpload("rounded")).toBe("rounded");
    expect(avatarCropAfterUpload("square")).toBe("square");
  });
});

describe("the crop lists behind the shape selectors", () => {
  it("keeps the bot selector and its grid in step", () => {
    // BotProfileAvatarCard lays BOT_AVATAR_CROPS out in a grid-cols-6
    // single row. Adding a crop without updating that class wraps the row;
    // this pins the count the grid is built for.
    expect(BOT_AVATAR_CROPS).toHaveLength(6);
  });

  it("offers groups only the crops GroupAvatar can draw", () => {
    expect(GROUP_AVATAR_CROPS).toEqual(["circle", "rounded", "square"]);
  });
});

describe("botAvatarRecolorableSchema", () => {
  it("accepts none/shell/full, legacy booleans, and nothing", () => {
    expect(botAvatarRecolorableSchema.safeParse("none").success).toBe(true);
    expect(botAvatarRecolorableSchema.safeParse("shell").success).toBe(true);
    expect(botAvatarRecolorableSchema.safeParse("full").success).toBe(true);
    expect(botAvatarRecolorableSchema.safeParse(true).data).toBe("shell");
    expect(botAvatarRecolorableSchema.safeParse(false).data).toBe("none");
    expect(botAvatarRecolorableSchema.safeParse(undefined).success).toBe(true);
    for (const value of ["true", 1, null, {}, "partial"]) {
      expect(botAvatarRecolorableSchema.safeParse(value).success).toBe(false);
    }
  });

  it("normalises and reports whether Color can recolour", () => {
    expect(normalizeAvatarRecolorable(true)).toBe("shell");
    expect(normalizeAvatarRecolorable(false)).toBe("none");
    expect(normalizeAvatarRecolorable("full")).toBe("full");
    expect(isAvatarRecolorable("shell")).toBe(true);
    expect(isAvatarRecolorable("none")).toBe(false);
    expect(isAvatarRecolorable(true)).toBe(true);
  });
});
