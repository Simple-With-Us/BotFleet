import { z } from "zod";

/** The mascot is a first-class avatar choice; the other values crop an image. */
export const BOT_AVATAR_CROPS = ["mascot", "tvface", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/** Groups get image crops only: GroupAvatar has no mascot or TV-Face
 * renderer (a group carries no expression or color to animate), so offering
 * either would select a shape nothing can draw. */
export const GROUP_AVATAR_CROPS = BOT_AVATAR_CROPS.filter(
  (crop) => crop !== "mascot" && crop !== "tvface",
);

/** An uploaded image only shows if the current crop renders images at all.
 * Mascot and TV-Face ignore avatarUrl, so an upload under either must flip
 * to a plain circle — otherwise the new image saves but never displays. */
export function avatarCropAfterUpload(crop: BotAvatarCrop): BotAvatarCrop {
  return crop === "mascot" || crop === "tvface" ? "circle" : crop;
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
