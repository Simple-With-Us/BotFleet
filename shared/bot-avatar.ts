import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = [
  "mascot",
  "tvface",
  "animated",
  "circle",
  "rounded",
  "square",
] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/** Groups get image crops only: GroupAvatar has no mascot or TV-Face
 * renderer (a group carries no expression or color to animate), so offering
 * either would select a shape nothing can draw. */
export const GROUP_AVATAR_CROPS = BOT_AVATAR_CROPS.filter(
  (crop) => crop !== "mascot" && crop !== "tvface" && crop !== "animated",
);

/** An uploaded image only shows if the current crop renders images at all.
 * Mascot and TV-Face ignore avatarUrl, so an upload under either must flip
 * to a plain circle — otherwise the new image saves but never displays.
 * An animated avatar only plays if the file it points at carries a manifest,
 * so a plain image uploaded over one flips to a circle too; the client
 * overrides this back to `animated` when the file it just uploaded does
 * carry a manifest. */
export function avatarCropAfterUpload(crop: BotAvatarCrop): BotAvatarCrop {
  return crop === "mascot" || crop === "tvface" || crop === "animated" ? "circle" : crop;
}

/**
 * Custom avatars are deliberately limited to this app's attachment server.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel.
 * Stored SVG/GIF/HEIC/BMP attachments are app-owned filenames, served
 * with nosniff (SVG also gets a sandbox CSP).
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp|heic|heif|avif|bmp|svg)$/,
    "must be a stored image attachment",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "mascot",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}

/**
 * How much of an uploaded / shipped avatar can take the Color row.
 *
 * - none:  fixed art (plain image, single-colour style).
 * - shell: recolour the body / bezel; glyphs stay authored (TV-Face).
 * - full:  every pixel may recolour.
 *
 * Manifest one-file WebPs that ship as shell packs set `shell` on upload.
 * Plain images set `none`.  Mascot and TV-Face crops always show Color.
 * Boolean true/false from older records still parse (true → shell, false → none).
 */
export const BOT_AVATAR_RECOLORABLE_MODES = ["none", "shell", "full"] as const;
export type BotAvatarRecolorable = (typeof BOT_AVATAR_RECOLORABLE_MODES)[number];

export const botAvatarRecolorableSchema = z.preprocess((value) => {
  if (value === true) return "shell";
  if (value === false) return "none";
  return value;
}, z.enum(BOT_AVATAR_RECOLORABLE_MODES).optional());

/** True when Color may recolour some part of the avatar (shell or full). */
export function isAvatarRecolorable(
  value: BotAvatarRecolorable | boolean | null | undefined,
): boolean {
  return value === true || value === "shell" || value === "full";
}

/** Stored recolorable value before normalisation (legacy boolean or enum). */
export type BotAvatarRecolorableInput = BotAvatarRecolorable | boolean | null | undefined;

/** Coerce legacy boolean or enum storage into the enum, or undefined. */
export function normalizeAvatarRecolorable(
  value: BotAvatarRecolorableInput,
): BotAvatarRecolorable | undefined {
  const parsed = botAvatarRecolorableSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}