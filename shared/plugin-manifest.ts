// The plugin manifest contract.  Every plugin carries a
// `botfleet-plugin.json` at its top level; this file is the schema.
//
// Two consumers:
//   - server/plugins.ts validates at install/update time and on every
//     boot before loading.
//   - tests/* round-trip the schema so a bad field never silently slips
//     past review.
//
// Mirrors the skills trust posture: validation errors name the field,
// say what was wrong, and say what was expected.  Anything less is a
// silent contract that means broken things.
import { z } from "zod";

export const HOST_API_VERSION = 1;

/** Recursive JSON value type.  Mirrors server/schema.ts § JsonValue.
 *  Declared here so a caller at the shared/plugin-manifest.ts boundary
 *  can hand a parsed JSON tree in without re-defining the same union. */
export type JsonPrimitive = null | boolean | number | string;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/** Plugin name gate.  Same shape as skill names so the on-disk layout
 *  stays predictable and `..` is structurally impossible. */
export const PLUGIN_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PLUGIN_NAME_MAX = 64;

/** Description is rendered in the listing and in the install review. */
export const PLUGIN_DESCRIPTION_MAX = 280;

/** Author / license are free strings, but bounded so a malicious
 *  manifest cannot write the entire Godwin's Law into a tool tip. */
export const PLUGIN_AUTHOR_MAX = 120;
export const PLUGIN_LICENSE_MAX = 64;

/** A command name is what the user types after the slash.  No
 *  spaces, no slashes, lowercase only — same grammar as a CLI tool. */
export const PLUGIN_COMMAND_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** Strict semver MAJOR.MINOR.PATCH with no pre-release or build
 *  metadata.  v1 is conservative; the moment a registry needs
 *  pre-release tags, this is the gate that opens. */
export const SEMVER = /^\d+\.\d+\.\d+$/;

/** Exactly the forms `satisfiesBotfleetVersion` can evaluate.  Anything
 *  else must fail validation at install time, not silently at enable time. */
const SUPPORTED_BOTFLEET_RANGE =
  /^(?:\d+|\d+\.\d+\.\d+|>=\s*\d+|<=\s*\d+|[\^~]\s*\d+\.\d+\.\d+)$/;

/** Capability allowlist for v1.  Adding a new capability is a breaking
 *  change because plugins render this without a fallback.  Unknown
 *  capabilities fail validation with the field name. */
export const PLUGIN_CAPABILITIES = [
  "read.bots",
  "read.status",
  "read.config",
] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

export const PLUGIN_CARD_LAYOUTS = ["stat-grid", "key-value", "list"] as const;
export type PluginCardLayout = typeof PLUGIN_CARD_LAYOUTS[number];

/** A botfleet version constraint.  Exactly the forms the gate evaluates:
 *  `>=N`, `<=N`, `^x.y.z`, `~x.y.z`, bare major, or bare MAJOR.MINOR.PATCH.
 *  Wider grammar (e.g. `>=1.0.0`, `1 || 2`) fails here so enable never
 *  sees an unsatisfiable-but-schema-valid constraint. */
const BOTFLEET_VERSION = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => SUPPORTED_BOTFLEET_RANGE.test(value.trim()), {
    message: 'expected ">=1", "<=1", "^1.2.0", "~1.2.0", or a bare MAJOR / MAJOR.MINOR.PATCH',
  });

const cardContribution = z.object({
  id: z.string().min(1).max(PLUGIN_NAME_MAX)
    .refine((value) => PLUGIN_NAME.test(value), {
      message: `expected a slug (lowercase alphanumerics with single hyphens, max ${PLUGIN_NAME_MAX})`,
    }),
  title: z.string().min(1).max(120),
  description: z.string().max(PLUGIN_DESCRIPTION_MAX).optional(),
  layout: z.enum(PLUGIN_CARD_LAYOUTS),
  fields: z.array(z.string().min(1).max(64)).max(16).optional(),
}).strict();

const commandContribution = z.object({
  name: z.string().min(1).max(32)
    .refine((value) => PLUGIN_COMMAND_NAME.test(value), {
      message: "expected a lowercase command name (letters, numbers, hyphens, max 32)",
    }),
  description: z.string().min(1).max(PLUGIN_DESCRIPTION_MAX),
  args: z.array(z.string().min(1).max(64)).max(8).optional(),
}).strict();

const contributes = z
  .object({
    cards: z.array(cardContribution).max(16).optional(),
    commands: z.array(commandContribution).max(16).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const card of value.cards ?? []) {
      if (seen.has(card.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cards"],
          message: `duplicate card id "${card.id}" within plugin`,
        });
      }
      seen.add(card.id);
    }
    const seenCmd = new Set<string>();
    for (const cmd of value.commands ?? []) {
      if (seenCmd.has(cmd.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["commands"],
          message: `duplicate command name "${cmd.name}" within plugin`,
        });
      }
      seenCmd.add(cmd.name);
    }
  })
  .optional();

/** Each capability must be one of PLUGIN_CAPABILITIES.  The enum is the
 *  validator, so the parsed array is already typed as PluginCapability[]
 *  with no cast.  An absent list parses as []. */
const capabilities = z
  .array(z.enum(PLUGIN_CAPABILITIES, {
    error: (issue) => `unknown capability "${String(issue.input)}"; allowed: ${PLUGIN_CAPABILITIES.join(", ")}`,
  }))
  .max(16)
  .optional()
  .default([]);

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1).max(PLUGIN_NAME_MAX)
      .refine((value) => PLUGIN_NAME.test(value), {
        message: `expected a slug (lowercase alphanumerics with single hyphens, max ${PLUGIN_NAME_MAX})`,
      }),
    version: z.string().min(1).max(32).refine((value) => SEMVER.test(value), {
      message: "expected semver MAJOR.MINOR.PATCH (e.g. \"1.0.0\")",
    }),
    description: z.string().min(1).max(PLUGIN_DESCRIPTION_MAX),
    author: z.string().min(1).max(PLUGIN_AUTHOR_MAX).optional(),
    license: z.string().min(1).max(PLUGIN_LICENSE_MAX).optional(),
    botfleet: BOTFLEET_VERSION,
    entry: z.string().min(1).max(256)
      .refine((value) => /^[\w./-]+\.(?:mjs|js)$/.test(value), {
        message: "expected a relative path ending in .mjs or .js",
      })
      .refine((value) => !value.startsWith("/") && !value.includes(".."), {
        message: "entry must be a relative path inside the plugin directory",
      }),
    capabilities,
    contributes,
  })
  .strict();

/** The full manifest as the host sees it after parsing.  Inferred from
 *  the schema, so consumer code relies on exactly what zod produced. */
export type PluginManifest = z.output<typeof pluginManifestSchema>;

export interface PluginManifestIssue {
  field: string;
  message: string;
}

export type PluginManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: PluginManifestIssue[] };

/** Parse a JSON value (already loaded from disk or buffer) into a
 *  manifest.  Returns the typed issues so the UI can render them
 *  one row at a time.  Accepts `unknown` because callers reach this
 *  function with a `JSON.parse` result that has no narrower type; the
 *  zod schema is the only thing that narrows it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function parsePluginManifest(value: unknown): PluginManifestParseResult {
  const result = pluginManifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  const issues: PluginManifestIssue[] = result.error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  return { ok: false, issues };
}

/** Parse a JSON string.  Same shape as parsePluginManifest, with a
 *  synthesized "invalid JSON" issue when the string does not parse. */
export function parsePluginManifestJson(text: string): PluginManifestParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          field: "(root)",
          message: error instanceof SyntaxError ? `manifest is not valid JSON: ${error.message}` : "manifest is not valid JSON",
        },
      ],
    };
  }
  return parsePluginManifest(value);
}

/** A conservative semver comparison that handles the four operators
 *  the manifest constraint accepts.  Returns true when `actual`
 *  satisfies `constraint`.  Anything we do not understand returns
 *  false — fail closed. */
export function satisfiesBotfleetVersion(constraint: string, actual: number): boolean {
  const trimmed = constraint.trim();
  // Bare major version: "1" means "host API major version 1".
  const bare = trimmed.match(/^(\d+)$/);
  if (bare) return actual === Number(bare[1]);
  if (SEMVER.test(trimmed)) {
    const major = Number(trimmed.split(".")[0]);
    return actual === major;
  }
  const ge = trimmed.match(/^>=\s*(\d+)$/);
  if (ge) return actual >= Number(ge[1]);
  const le = trimmed.match(/^<=\s*(\d+)$/);
  if (le) return actual <= Number(le[1]);
  const caret = trimmed.match(/^\^\s*(\d+)\.(\d+)\.(\d+)$/);
  if (caret) {
    const [, a, b, c] = caret;
    if (Number(b) === 0 && Number(c) === 0) return actual === Number(a);
    if (Number(c) === 0) {
      const upper = `${Number(a)}.${Number(b) + 1}.0`;
      return actual >= Number(a) && actual <= Number(upper.split(".")[0]);
    }
    return actual === Number(a);
  }
  const tilde = trimmed.match(/^~\s*(\d+)\.(\d+)\.(\d+)$/);
  if (tilde) {
    const [, a, b] = tilde;
    const upper = `${a}.${Number(b) + 1}.0`;
    return actual >= Number(a) && actual <= Number(upper.split(".")[0]);
  }
  return false;
}