import { describe, expect, it } from "vitest";

import {
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

  it("keeps the person's chosen image crop", () => {
    expect(avatarCropAfterUpload("circle")).toBe("circle");
    expect(avatarCropAfterUpload("rounded")).toBe("rounded");
    expect(avatarCropAfterUpload("square")).toBe("square");
  });
});

describe("the crop lists behind the shape selectors", () => {
  it("keeps the bot selector and its grid in step", () => {
    // BotProfileAvatarCard lays BOT_AVATAR_CROPS out in a grid-cols-5
    // single row. Adding a crop without updating that class wraps the row;
    // this pins the count the grid is built for.
    expect(BOT_AVATAR_CROPS).toHaveLength(5);
  });

  it("offers groups only the crops GroupAvatar can draw", () => {
    expect(GROUP_AVATAR_CROPS).toEqual(["circle", "rounded", "square"]);
  });
});
