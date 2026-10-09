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
 * where the bot is.
 *
 * Loose, because the same route is the desktop's general bot editor and every
 * other key it accepts (the persona fields, computers, working folder) has its
 * own validation in `parseBotProfilePatch` and beside it. */
export const botOrganizeSchema = z
  .object(
    {
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
    },
    { error: "body must be a JSON object" },
  )
  .loose();

export type BodyCheck = { ok: true } | { ok: false; error: string };

/** The organize fields of a bot PATCH body are well typed, or the sentence to
 * answer 400 with. */
export function checkBotOrganizeBody(body: JsonInput): BodyCheck {
  const parsed = botOrganizeSchema.safeParse(body);
  return parsed.success ? { ok: true } : { ok: false, error: parsed.error.issues[0]?.message ?? "invalid bot patch" };
}

/** `PATCH /api/auto-update`: one boolean.  Any other key is ignored, not
 * stored; the route builds its config patch from `enabled` alone. */
export const autoUpdateBodySchema = z
  .object({ enabled: z.boolean({ error: "enabled must be true or false" }) }, { error: "body must be a JSON object" })
  .loose();

export type AutoUpdateBody = { ok: true; enabled: boolean } | { ok: false; error: string };

export function parseAutoUpdateBody(body: JsonInput): AutoUpdateBody {
  const parsed = autoUpdateBodySchema.safeParse(body);
  return parsed.success
    ? { ok: true, enabled: parsed.data.enabled }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "enabled must be true or false" };
}
