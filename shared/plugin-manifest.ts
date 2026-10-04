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

const SEMVER_RANGE = /^[><=^~]*\s*\d+(?:\.\d+\.\d+)?(?:\s*\|\|\s*[><=^~]*\s*\d+(?:\.\d+\.\d+)?)*$/;

/** Capability allowlist for v1.  Adding a new capability is a breaking
 *  change because plugins render this without a fallback.  Unknown
 *  capabilities fail validation with the field name. */
export const PLUGIN_CAPABILITIES = [
  "read.bots",
  "read.status",
  "read.config",
] as const;
export type PluginCapability = typeof PLUGIN_CAPABILITIES[number];

function isPluginCapability(value: string): value is PluginCapability {
  // SAFETY: PLUGIN_CAPABILITIES is a readonly tuple of string literals; widening it to `readonly string[]` is the only way to call Array.prototype.includes on a tuple in TypeScript.
  return (PLUGIN_CAPABILITIES as readonly string[]).includes(value);
}

export const PLUGIN_CARD_LAYOUTS = ["stat-grid", "key-value", "list"] as const;
export type PluginCardLayout = typeof PLUGIN_CARD_LAYOUTS[number];

/** A botfleet version constraint.  v1 supports the four operators that
 *  matter for a single-host scenario: `>=`, `<=`, `^`, `~`, and a bare
 *  version.  Anything else fails validation. */
const BOTFLEET_VERSION = z
  .string()
  .min(1)
  .max(32)
  .refine((value) => SEMVER_RANGE.test(value), {
    message: "expected a semver range like \">=1\", \"^1.2.0\", or a bare MAJOR.MINOR.PATCH",
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
});

const commandContribution = z.object({
  name: z.string().min(1).max(32)
    .refine((value) => PLUGIN_COMMAND_NAME.test(value), {
      message: "expected a lowercase command name (letters, numbers, hyphens, max 32)",
    }),
  description: z.string().min(1).max(PLUGIN_DESCRIPTION_MAX),
  args: z.array(z.string().min(1).max(64)).max(8).optional(),
});

const contributes = z
  .object({
    cards: z.array(cardContribution).max(16).optional(),
    commands: z.array(commandContribution).max(16).optional(),
  })
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

const capabilities = z
  .array(z.string().min(1).max(64))
  .max(16)
  .optional()
  .superRefine((value, ctx) => {
    for (const [index, entry] of (value ?? []).entries()) {
      if (!isPluginCapability(entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message:
            `unknown capability "${entry}"; allowed: ${PLUGIN_CAPABILITIES.join(", ")}`,
        });
      }
    }
  });

/** The full manifest as the host sees it after parsing.  Every field is
 *  exactly what zod produced; consumer code can rely on the shape. */
export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  botfleet: string;
  entry: string;
  capabilities: PluginCapability[];
  contributes?: {
    cards?: Array<{
      id: string;
      title: string;
      description?: string;
      layout: PluginCardLayout;
      fields?: string[];
    }>;
    commands?: Array<{
      name: string;
      description: string;
      args?: string[];
    }>;
  };
}

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
  .superRefine((value, ctx) => {
    // entry must not be absolute; the relative-path regex already covers it,
    // but double-check for paranoia's sake.
    if (value.entry.startsWith("/")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entry"],
        message: "entry must be a relative path inside the plugin directory",
      });
    }
  });

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
 *  function with a `JSON.parse` result that has no narrower type. */
export function parsePluginManifest(value: JsonValue | unknown): PluginManifestParseResult {
  const result = pluginManifestSchema.safeParse(value);
  if (result.success) {
    return {
      ok: true,
      manifest: {
        name: result.data.name,
        version: result.data.version,
        description: result.data.description,
        author: result.data.author,
        license: result.data.license,
        botfleet: result.data.botfleet,
        entry: result.data.entry,
        // SAFETY: the zod schema validates each capability against PLUGIN_CAPABILITIES before this point, so the array is already narrowed to that union.
        capabilities: (result.data.capabilities ?? []) as PluginCapability[],
        contributes: result.data.contributes,
      },
    };
  }
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
    // SAFETY: JSON.parse returns `any`; we pass it straight to zod's safeParse which accepts unknown, so the cast does not narrow in any meaningful way and the unknown alias below is the type the caller will see.
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          field: "(root)",
          // SAFETY: JSON.parse only throws SyntaxError, which has a `message` string property — every catch from a JSON.parse failure carries that shape.
          message: `manifest is not valid JSON: ${(error as Error).message}`,
        },
      ],
    };
  }
  // SAFETY: JSON.parse returns a JSON-compatible value (string, number, boolean, null, array, or plain object); JsonValue is the closed union of those shapes, so the cast downcasts to the parser's documented input type.
  return parsePluginManifest(value as JsonValue);
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