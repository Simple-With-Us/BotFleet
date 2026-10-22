import { z } from "zod";

import { botAvatarCropSchema, botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS, MAX_TOOL_ROUNDS } from "../shared/bot-profile.ts";
import {
  CONNECTOR_SLUGS_MAX,
  CONNECTOR_SLUG_PATTERN,
  CONNECTOR_TOOLS_PER_SERVICE_MAX,
  CONNECTOR_TOOL_NAME_PATTERN,
} from "../shared/connector-tools.ts";

import type { BotRecord } from "./store.ts";

export const BOT_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  "speakReplies",
  "modelSelection",
  "chiefOfStaff",
  "approvePeerComms",
  "autoApprove",
  "autoReview",
  "composio",
  "connectorTools",
  "cloudBackend",
  "autoStartVps",
  "cwd",
  "extraCwds",
  "userNotes",
  "effort",
  "computers",
  "maxToolRounds",
] as const;

/** One service's grant, `{ tools: "*" }` for every tool Composio offers on
 * it or `{ tools: [...] }` for an exact list — never an empty list; a
 * service that should reach no tools is left out of the record entirely,
 * which parseBotProfilePatch normalizes to `undefined` from a null clear. */
const connectorToolGrantSchema = z
  .object({
    tools: z.union(
      [
        z.literal("*"),
        z
          .array(
            z.string().regex(CONNECTOR_TOOL_NAME_PATTERN, {
              error: "connectorTools tool names must be Composio tool names like GMAIL_SEND_EMAIL",
            }),
          )
          .min(1, { error: 'connectorTools.<service>.tools must be "*" or a non-empty list (omit the service to grant it no tools)' })
          .max(CONNECTOR_TOOLS_PER_SERVICE_MAX, {
            error: `connectorTools may list at most ${CONNECTOR_TOOLS_PER_SERVICE_MAX} tools per service`,
          }),
      ],
      { error: 'connectorTools.<service> must be a grant like { tools: "*" } or { tools: ["TOOL_NAME"] }' },
    ),
  })
  .strict();

const connectorToolsSchema = z
  .record(
    z.string().regex(CONNECTOR_SLUG_PATTERN, { error: "connectorTools service slugs must be lowercase slugs" }),
    connectorToolGrantSchema,
  )
  .refine((value) => Object.keys(value).length <= CONNECTOR_SLUGS_MAX, {
    error: `connectorTools may name at most ${CONNECTOR_SLUGS_MAX} services`,
  });


/** Integer 1..MAX_TOOL_ROUNDS, else absent. Empty/null/invalid all mean unset. */
export function resolveMaxToolRounds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  if (value < 1 || value > MAX_TOOL_ROUNDS) return undefined;
  return value;
}

const profilePatchSchema = z.object({
  name: z
    .string({ error: "name must be a string" })
    .max(BOT_PROFILE_LIMITS.name, { error: "name must be at most 100 characters" })
    .refine((value) => Boolean(value.trim()), { error: "name must not be empty" })
    .optional(),
  title: z
    .string({ error: "title must be a string" })
    .max(BOT_PROFILE_LIMITS.title, { error: "title must be at most 200 characters" })
    .optional(),
  description: z
    .string({ error: "description must be a string" })
    .max(BOT_PROFILE_LIMITS.description, { error: "description must be at most 4000 characters" })
    .optional(),
  notifications: z.boolean({ error: "notifications must be true or false" }).optional(),
  avatarUrl: z
    .union([botAvatarUrlSchema, z.literal(""), z.null()], {
      error: "avatarUrl must be a stored image attachment",
    })
    .optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  voice: z
    .string({ error: "voice must be a string" })
    .max(BOT_PROFILE_LIMITS.voice, { error: "voice must be at most 200 characters" })
    .optional(),
  speakReplies: z.boolean({ error: "speakReplies must be true or false" }).optional(),
  modelSelection: z.any().optional(),
  chiefOfStaff: z.boolean({ error: "chiefOfStaff must be true or false" }).optional(),
  approvePeerComms: z.boolean({ error: "approvePeerComms must be true or false" }).optional(),
  autoApprove: z.boolean({ error: "autoApprove must be true or false" }).optional(),
  autoReview: z.enum(["off", "shadow", "enforce"], { error: "autoReview must be off, shadow, or enforce" }).optional(),
  composio: z.boolean({ error: "composio must be true or false" }).optional(),
  connectorTools: z.union([connectorToolsSchema, z.null()]).optional(),
  cloudBackend: z.enum(["box", "vps"], { error: "cloudBackend must be box or vps" }).optional(),
  autoStartVps: z.boolean({ error: "autoStartVps must be true or false" }).optional(),
  cwd: z.union([z.string(), z.literal(""), z.null()]).optional(),
  extraCwds: z.array(z.string()).optional(),
  userNotes: z.string().max(20000).optional(),
  effort: z.string().max(50).optional(),
  computers: z.array(z.enum(["cloud", "vm", "local"])).optional(),
  // Integer 1..MAX_TOOL_ROUNDS kept; null/"" /invalid → undefined (absent).
  maxToolRounds: z.any().optional(),
});

export type BotProfilePatchInput = z.input<typeof profilePatchSchema>;

export type BotProfilePatch = Partial<
  Pick<
    BotRecord,
    | "name"
    | "title"
    | "description"
    | "notifications"
    | "avatarUrl"
    | "avatarCrop"
    | "voice"
    | "speakReplies"
    | "modelSelection"
    | "activeModelSelection"
    | "chiefOfStaff"
    | "approvePeerComms"
    | "autoApprove"
    | "autoReview"
    | "composio"
    | "connectorTools"
    | "cloudBackend"
    | "autoStartVps"
    | "cwd"
    | "extraCwds"
    | "userNotes"
    | "computers"
    | "maxToolRounds"
  >
> & { effort?: string };

export type BotProfilePatchResult =
  | { ok: true; patch: BotProfilePatch }
  | { ok: false; error: string };

/**
 * The shared validation boundary for profile fields. The desktop's broad bot
 * PATCH passes strict=false; paired clients use strict=true so a future bot
 * field cannot silently become remotely writable.
 *
 * avatarUrl deliberately uses `undefined` as the normalized clear value.
 * Store persistence already omits undefined fields, while wireBot sends null
 * back to clients so Codable and object-spread clients both clear stale data.
 */
export function parseBotProfilePatch(input: BotProfilePatchInput, strict = false): BotProfilePatchResult {
  const parsed = (strict ? profilePatchSchema.strict() : profilePatchSchema).safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported profile field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "avatarCrop") {
      return { ok: false, error: "avatarCrop must be mascot, circle, rounded, or square" };
    }
    return { ok: false, error: issue?.message ?? "invalid profile patch" };
  }

  const { avatarUrl, cwd, connectorTools, maxToolRounds: _maxToolRounds, ...fields } = parsed.data;
  const patch: BotProfilePatch = fields;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || undefined;
  if (cwd !== undefined) patch.cwd = cwd || undefined;
  // null is the API-edge clear (matches avatarUrl/cwd): it returns the bot
  // to legacy all-tools behavior. undefined here (the key was absent from
  // the request) leaves any existing grants alone — patchBot only touches
  // keys actually present on the patch object.
  if (connectorTools !== undefined) patch.connectorTools = connectorTools === null ? undefined : connectorTools;
  // maxToolRounds: key present → resolve (null/"" /invalid become undefined
  // clear); key absent → leave existing value alone.
  if (Object.prototype.hasOwnProperty.call(parsed.data, "maxToolRounds")) {
    patch.maxToolRounds = resolveMaxToolRounds(parsed.data.maxToolRounds);
  }
  return { ok: true, patch };
}
