// Request bodies a paired phone writes through the sidecar, parsed with zod.
//
// The sidecar (companion/src/routes.ts) already refuses every field that is
// not on its list, but the harness route behind it has other callers, and a
// guard that only one of them honors is not a guard.  So the harness checks
// the same shapes itself, here, in one place a test can reach without booting
// a server.
import { z } from "zod";

const flag = (name: string) => z.boolean({ error: `${name} must be true or false` }).optional();

const PINNED_MESSAGE_ERROR = "pinnedMessageId must be a message id or null";

/** What `readBody` hands the routes, spelled as data rather than `unknown`. */
type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { [key: string]: JsonInput };

/** The six roster-organization fields of `PATCH /api/bots/:id`: Archive and
 * Restore (`hidden`), Pin (`pinned`), Mark As Unread (`unread`), Make Chief Of
 * Staff (`chiefOfStaff`), Move To Section (`section`) and Pin Message
 * (`pinnedMessageId`).  Only their TYPES are checked here.  Length limits, the
 * trim, and the rules that need the stored bot stay in the route, which is
 * where the bot is. */
const botOrganizeFields = {
  hidden: flag("hidden"),
  pinned: flag("pinned"),
  unread: flag("unread"),
  chiefOfStaff: flag("chiefOfStaff"),
  section: z.union([z.string(), z.null()], { error: "section must be a string or null" }).optional(),
  pinnedMessageId: z
    .union(
      [z.string().regex(/^[\w-]*$/, { error: PINNED_MESSAGE_ERROR }), z.null()],
      { error: PINNED_MESSAGE_ERROR },
    )
    .optional(),
};

const BODY_ERROR = "body must be a JSON object";

/** The desktop's body: loose, because the same route is its general bot
 * editor and every other key it accepts (the persona fields, computers,
 * working folder) has its own validation in `parseBotProfilePatch` and beside
 * it. */
export const botOrganizeSchema = z.object(botOrganizeFields, { error: BODY_ERROR }).loose();

/** A paired phone's body: exactly the six fields and nothing else.  The
 * sidecar refuses the same keys first; this is the second wall, for a request
 * that reaches the harness some other way carrying the phone's header. */
export const phoneBotOrganizeSchema = z.object(botOrganizeFields, { error: BODY_ERROR }).strict();

export type BodyCheck = { ok: true } | { ok: false; status: 400 | 403; error: string };

/** The organize fields of a bot PATCH body are well typed, or the status and
 * sentence to answer with.  `fromPhone` (the harness reads it off the
 * sidecar's `x-botfleet-companion` header) selects the strict schema, so a key
 * outside the six is a 403 with the same sentence the sidecar gives, never
 * dropped or passed on. */
export function checkBotOrganizeBody(body: JsonInput, fromPhone: boolean): BodyCheck {
  const parsed = (fromPhone ? phoneBotOrganizeSchema : botOrganizeSchema).safeParse(body);
  if (parsed.success) return { ok: true };
  const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
  if (unsupported?.code === "unrecognized_keys") {
    return {
      ok: false,
      status: 403,
      error: `${unsupported.keys[0] ?? "that field"} can only be changed in BotFleet on your computer`,
    };
  }
  return { ok: false, status: 400, error: parsed.error.issues[0]?.message ?? "invalid bot patch" };
}

/** `PATCH /api/auto-update`: one boolean.  A phone-only route, so keys beside
 * `enabled` are stripped at parse time; the route builds its config patch
 * from the parsed result alone. */
export const autoUpdateBodySchema = z
  .object({ enabled: z.boolean({ error: "enabled must be true or false" }) }, { error: BODY_ERROR })
  .strip();

export type AutoUpdateBody = { ok: true; enabled: boolean } | { ok: false; error: string };

export function parseAutoUpdateBody(body: JsonInput): AutoUpdateBody {
  const parsed = autoUpdateBodySchema.safeParse(body);
  return parsed.success
    ? { ok: true, enabled: parsed.data.enabled }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "enabled must be true or false" };
}
