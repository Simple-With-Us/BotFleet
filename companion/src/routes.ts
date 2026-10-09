// What a paired device is allowed to ask for.
//
// The default is deny, and that direction is the whole point: the sidecar
// sits in front of an API it does not own and cannot see the future of. A
// route that appears in the harness later is closed to phones until someone
// decides otherwise, because the alternative is that every upstream release
// silently widens what a lost phone can reach.
//
// This file used to claim that and not do it — it listed refusals and let
// everything else under `/api/` through. In the time between writing it and
// noticing, upstream added webhook triggers, connected-app authorisation and
// routines, all of which a paired phone could drive: minting an
// internet-reachable trigger, rotating a signing secret out from under
// whatever was sending to it, disconnecting a Google account. None of that
// was a decision anyone made. It was the default.
//
// So the list below is the surface, derived from what the app actually
// calls. Adding a feature to the phone means adding its route here, on
// purpose, in a diff someone can read. That cost is the feature.

import type { JsonObject, JsonValue } from "./json.ts";

/** A refusal to send back, or null to let the request through. */
export interface Denial {
  status: number;
  error: string;
}

/** One request, reduced to what the allowlist decides on. */
export interface RouteRequest {
  path: string;
  method: string;
  /** Whether the bearer token on the request matched a paired device. */
  authenticated: boolean;
}

/** The one companion route that crosses into full interactive desktop
 * control. Both the allowlist and capability gate consume this classifier so
 * their security decisions cannot drift apart. */
export const CLOUD_DESKTOP_JOIN_ROUTE = {
  method: "POST",
  path: /^\/api\/bots\/[\w-]+\/computer\/join$/,
} as const;

export function isCloudDesktopJoin(method: string, path: string): boolean {
  return method === CLOUD_DESKTOP_JOIN_ROUTE.method && CLOUD_DESKTOP_JOIN_ROUTE.path.test(path);
}

/** The profile fields a paired phone owns.  Engine choice is deliberately
 * included: the native model picker is a companion feature.  Connected apps
 * and host paths remain Mac-only.
 *
 * `computers` is on the list since 2026-10-08, and only partly.  The phone
 * may switch the sandboxed destinations (cloud, vm).  Whether the bot holds
 * This Mac (`local`, the person's real desktop) is still the Mac's decision,
 * and the sidecar cannot enforce that half: telling "kept local" from "added
 * local" needs the stored bot.  The harness's profile route owns that check
 * (`PAIRED_LOCAL_COMPUTER_ERROR` in server/index.ts) and answers 403 with its
 * own message, so the guard binds every caller of the route, not only this
 * proxy.  `maxToolRounds` is a 1 to 200 budget the harness clamps, added
 * because the native control shipped (#649) without anyone extending this
 * list, not because anyone decided to keep it off the phone.  `cwd` is open
 * only because the harness confines it: from a paired phone (the proxy stamps
 * `x-botfleet-companion`) a bot's folder may reuse or narrow one this
 * computer already shares with a bot or room, as a room folder set from the
 * phone is confined, and anything else is a 403 with the reason.
 *
 * `autoApprove`, `autoReview`, `approvePeerComms` and `bypassPermissions` are
 * on the list since 2026-10-09, by owner ruling.  Asked whether the phone may
 * change the execution policy, with "as close to full parity as possible" as
 * the standing goal, the owner answered "Bots should have bypass permissions
 * options too or YOLO or whatever."  #323 (audit BF-IOS-001) had kept all of
 * them on the computer, and the native sheet showed them read-only.  What did
 * NOT move is host control of the person's real desktop:
 *   - The harness profile route refuses to turn Auto-Approve ON for a bot that
 *     can use This Mac, with the same acknowledgement rule the desktop applies
 *     (`localAutoAcknowledgementError` in server/index.ts).  Auto-Approve is the
 *     one switch that lets a click on the real desktop go unasked, and its
 *     warning dialog is the Mac's, so a phone cannot create that pair.  Like
 *     `computers`, that check needs the stored bot and lives there rather than
 *     here.  Turning it off is always the phone's.
 *   - Bypass Permissions never answers a request that controls This Mac
 *     (server/auto-approve.ts excludes `scope === "local-computer"`), so host
 *     control still asks even on a bot the phone put in bypass, and the phone
 *     may switch it on for any bot.
 *   - The This Mac grant itself is still the Mac's alone (see `computers`). */
export const COMPANION_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  // Per-device overrides of voice ({ mac?, iphone? }).  The phone sets its
  // own Personal Voice here and may pick a hosted voice for the Mac; the
  // harness validates the shape and merges it with the stored record.
  "voices",
  "speakReplies",
  "speechDevices",
  "modelSelection",
  "computers",
  "maxToolRounds",
  "cwd",
  // Execution policy, open to the phone by the 2026-10-09 owner ruling above.
  // The harness validates each value, and refuses to turn autoApprove ON for
  // a bot that can use This Mac.
  "autoApprove",
  "autoReview",
  "approvePeerComms",
  "bypassPermissions",
  // The bot's On/Off switch (shared/bot-power.ts).  It only ever stops or
  // resumes work the person could already start by messaging the bot, grants
  // no capability, and the phone has to be able to turn a bot back On: the
  // disabled composer's one button is Turn On.
  "off",
] as const;

const COMPANION_PROFILE_PATCH_FIELD_SET = new Set<string>(COMPANION_PROFILE_PATCH_FIELDS);

export function isCompanionProfilePatch(method: string, path: string): boolean {
  return method === "PATCH" && /^\/api\/bots\/[\w-]+\/profile$/.test(path);
}

/** Validate the paired-device field boundary before a profile body reaches
 * the broader loopback harness route.  Reject the whole request rather than
 * silently stripping a field the person expected to save. */
export function companionProfilePatchDenial(body: JsonObject): Denial | null {
  const unsupported = Object.keys(body).find((field) => !COMPANION_PROFILE_PATCH_FIELD_SET.has(field));
  return unsupported
    ? { status: 403, error: `${unsupported} can only be changed in BotFleet on your computer` }
    : null;
}

/** The one bot-level `PATCH /api/bots/:id` a paired phone may send.
 *
 * The harness route behind it is the desktop's general bot editor.  It also
 * reads execution policy (`autoApprove`, `bypassPermissions`, `alwaysAllow`,
 * `autoReview`), computer grants, working folders, connected apps, the cloud
 * backend and the persona fields, and none of that is decided here.  So the
 * request is classified once, and the proxy refuses any body that names a
 * field outside `COMPANION_BOT_ORGANIZE_FIELDS`, the same way it filters the
 * profile route.  `ALLOWED` and the proxy's body check share this constant so
 * the two cannot drift apart. */
export const COMPANION_BOT_ORGANIZE_ROUTE = {
  method: "PATCH",
  path: /^\/api\/bots\/[\w-]+$/,
} as const;

export function isCompanionBotOrganize(method: string, path: string): boolean {
  return method === COMPANION_BOT_ORGANIZE_ROUTE.method && COMPANION_BOT_ORGANIZE_ROUTE.path.test(path);
}

/** How a person organizes the roster from the sidebar menu: Archive and
 * Restore (`hidden`), Pin (`pinned`), Mark As Unread (`unread`), Make Chief Of
 * Staff (`chiefOfStaff`), Move To Section (`section`), and Pin Message
 * (`pinnedMessageId`).  Each one changes where a bot sits or how it is
 * marked, never what it may do.  An archived bot keeps every transcript and
 * can be restored. */
export const COMPANION_BOT_ORGANIZE_FIELDS = [
  "hidden",
  "pinned",
  "unread",
  "chiefOfStaff",
  "section",
  "pinnedMessageId",
] as const;

const COMPANION_BOT_ORGANIZE_FIELD_SET = new Set<string>(COMPANION_BOT_ORGANIZE_FIELDS);
const BOT_ORGANIZE_BOOLEAN_FIELDS = new Set<string>(["hidden", "pinned", "unread", "chiefOfStaff"]);

/** Validate the organize boundary before a body reaches the harness.  The
 * harness copies `hidden`, `pinned` and `unread` into the stored bot without
 * looking at their type, so the types are checked here as well as the names.
 * Whole-request rejection, like the profile route: a field the person
 * expected to save is never silently dropped.  The harness stays the
 * authority on length limits and on rules that need the stored bot (it
 * refuses to archive the Chief of Staff). */
export function companionBotOrganizeDenial(body: JsonObject): Denial | null {
  const fields = Object.keys(body);
  if (fields.length === 0) return { status: 400, error: "nothing to save" };
  const unsupported = fields.find((field) => !COMPANION_BOT_ORGANIZE_FIELD_SET.has(field));
  if (unsupported) {
    return { status: 403, error: `${unsupported} can only be changed in BotFleet on your computer` };
  }
  for (const field of fields) {
    const value = body[field];
    if (BOT_ORGANIZE_BOOLEAN_FIELDS.has(field)) {
      if (value !== true && value !== false) return { status: 400, error: `${field} must be true or false` };
    } else if (field === "section") {
      if (value !== null && !isJsonString(value)) {
        return { status: 400, error: "section must be a string or null" };
      }
    } else if (field === "pinnedMessageId") {
      if (value !== null && !(isJsonString(value) && /^[\w-]*$/.test(value))) {
        return { status: 400, error: "pinnedMessageId must be a message id or null" };
      }
    }
  }
  return null;
}

/** A string out of `JSON.parse`, which never yields a boxed one, so the
 * object tag is the same test as `typeof` without the runtime-typeof lint. */
function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

/** The body check a request needs before it is forwarded, or null when the
 * allowlist alone decides it.  One lookup for the proxy, so a new filtered
 * route is one line here rather than another branch there. */
export function companionBodyCheck(
  method: string,
  path: string,
): ((body: JsonObject) => Denial | null) | null {
  if (isCompanionProfilePatch(method, path)) return companionProfilePatchDenial;
  if (isCompanionBotOrganize(method, path)) return companionBotOrganizeDenial;
  return null;
}

/** Every request the iOS app makes, and nothing else.
 *
 * Ids are `[\w-]+`, matching the harness's own route patterns. The paths
 * arrive undecoded and are anchored at both ends, so an encoded traversal
 * fails to match and is denied rather than forwarded — the failure mode of
 * a strict pattern is a closed door, which is the one to have. */
const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [
  // configured-or-not booleans. The write side is refused below: reading
  // which providers are set up is not reading their keys.
  { method: "GET", path: /^\/api\/config$/ },
  // What rooms are called is a display word, not a credential. It has its own
  // narrow route so the phone can change it without /api/config — which
  // carries API keys — ever accepting a write from a device.
  { method: "PATCH", path: /^\/api\/terminology$/ },
  { method: "PATCH", path: /^\/api\/conversation-mode$/ },
  // Display preferences only — never secrets. Mirrors terminology: each
  // setting gets its own narrow route so /api/config stays write-closed.
  { method: "PATCH", path: /^\/api\/features$/ },
  { method: "PATCH", path: /^\/api\/room-turn-timeout$/ },
  // Check For Updates Automatically: one boolean, `{ "enabled": bool }`.  It
  // lives in /api/config beside API keys, so like terminology it gets its own
  // route and /api/config stays write-closed.  Reading it needs no new route,
  // because GET /api/config already carries `autoUpdate.enabled`.
  { method: "PATCH", path: /^\/api\/auto-update$/ },
  { method: "PATCH", path: /^\/api\/profile$/ },
  { method: "GET", path: /^\/api\/events$/ },
  { method: "GET", path: /^\/api\/instances$/ },
  // Sidecar-owned, authenticated endpoint metadata. The proxy terminates it
  // locally; it never becomes a newly exposed harness route.
  { method: "GET", path: /^\/api\/companion\/endpoints$/ },
  { method: "POST", path: /^\/api\/companion\/push-token$/ },
  // Whether closed-app wake is actually working, so the phone can say so in
  // Settings instead of leaving a silent push path looking healthy.  Counts
  // and Apple's own status strings only — never anything about the key.
  { method: "GET", path: /^\/api\/companion\/push-health$/ },

  // the fleet, and making a bot
  { method: "GET", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/bots$/ },
  { method: "POST", path: /^\/api\/desktop\/open$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/read$/ },
  // always-allow is Mac-only: a stolen phone token must not widen Auto.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  // Paired-safe profile subset. The proxy validates the JSON field set
  // before forwarding it to the broader harness route.
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/profile$/ },
  // Roster organization: Archive, Restore, Pin, Mark As Unread, Make Chief Of
  // Staff, Move To Section and Pin Message.  The same bot PATCH the desktop
  // sidebar uses, behind a field allowlist the proxy enforces on the body
  // (`companionBotOrganizeDenial`).  Execution policy and computer grants
  // never pass.
  COMPANION_BOT_ORGANIZE_ROUTE,
  // Deleting a bot.  Irreversible, so the native app asks first and names
  // what is lost.  The harness stops a running turn, removes the bot's
  // computers and transcripts, and disables its routines and triggers.  The
  // owner ruled (2026-10-09) that bot management belongs on the phone.
  { method: "DELETE", path: /^\/api\/bots\/[\w-]+$/ },
  // Apply Primary and Fallback models to every bot at once (the desktop's
  // Settings > Models "Set All Bots To Default").  Nothing is stored as a
  // workspace default and no credential is read: each bot's `modelSelection`
  // is already phone-editable through the profile route, and this is the same
  // write fanned out.  Its sibling `apply-defaults` grants computers to every
  // bot, and stays on the Mac.
  { method: "POST", path: /^\/api\/bots\/apply-model-defaults$/ },
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  // Rename, bulletin, roster, section and Pin Message (`pinnedMessageId`).
  // The harness confines any working folder a phone sets here.
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+$/ },
  // Deleting a room removes its transcripts and tasks; the bots in it stay.
  // The native app confirms first.
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/read$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },

  // a transcript, its images, and answering an approval
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/export$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/approve-all$/ },
  { method: "GET", path: /^\/api\/search$/ },

  // App-owned profile images. Upload is image-only and capped at 10 MB by
  // the harness; GET is a single bare generated filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i },

  // Renderer-neutral voice operations. Neither route reads or writes the
  // workspace MiniMax key; the phone receives labels or audio only.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },
  // The workspace default voice and the pronunciation list: settings, not
  // credentials.  Each is its own narrow harness route that validates and
  // saves only that field, the way terminology does, so /api/config (which
  // carries the voice key) stays write-closed to a phone.
  { method: "PATCH", path: /^\/api\/tts\/default-voice$/ },
  { method: "PATCH", path: /^\/api\/tts\/pronunciations$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio\/\d+$/ },

  // The phone's own voice recordings.  Playing one back reads a WAV the
  // harness stored for that user message, and the review route stores a text
  // note on it; neither forks the thread, reruns a bot, or rewrites the
  // recognizer's original.  The native chat view calls both, and they used to
  // answer "no route" because nobody added them here.
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/recording$/ },
  { method: "PATCH", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/recording-review$/ },

  // Routines create ordinary tasks using an existing agent configuration.
  // Webhook management remains explicitly denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },
  // Run receipts: stop one that is queued, running or waiting, and mark a
  // failure as seen.  Both act on a run that already exists and neither
  // creates, edits or deletes a routine, so a lost phone gains no new reach.
  // The bare `POST /api/routine-runs/seen` is the "mark every failure seen"
  // sweep; it clears the badge and keeps every run, status and error.
  { method: "POST", path: /^\/api\/routine-runs\/[\w-]+\/(?:cancel|seen)$/ },
  { method: "POST", path: /^\/api\/routine-runs\/seen$/ },

  // Checking for a newer BotFleet and installing it.  The phone is the one
  // place an update is convenient to start — the Mac is usually mid-work when
  // someone notices a build is stale.  A busy Mac does not refuse: the
  // updater holds new work, gives running bots a short grace, then pauses
  // and resumes what is left (server/update-drain.ts); `{ "force": true }`
  // skips the grace.  `status` is a read; `check` and `run` are the two actions.
  // While new work is held, `status` also carries `drain` (what is waiting and
  // when the restart begins), pushed as `update.status`: that is how the phone
  // tells a person their message is saved.  `GET /api/runtime`, which reports
  // the same hold, needs the harness owner's token and stays closed.
  { method: "GET", path: /^\/api\/update\/status$/ },
  { method: "POST", path: /^\/api\/update\/check$/ },
  { method: "POST", path: /^\/api\/update\/run$/ },

  // Connected apps have full parity with the computer: list, authorize, and
  // detach an account.
  //
  // Authorize and revoke used to stay on the Mac, on the reasoning that a
  // stolen phone token must not start OAuth or detach an account.  Two things
  // decided against it.  The phone shipped the Connect button anyway — the
  // iOS view was written to authorize — so the policy was not a locked door,
  // it was a button that failed at the tap.  And the door it guarded is
  // narrow: starting OAuth still needs the provider's own login in a browser
  // and can only ADD an account, while a phone that can drive a bot with a
  // connected app can already do what that app permits.  Owner's call,
  // 2026-09-04: parity, so the roster on the phone means what it says.
  //
  // `accounts/:id` is the detach route; the bare `DELETE /api/connectors/:slug`
  // remains off the list, and EXPLAINED still names the family for anything
  // here that is not spelled out.
  { method: "GET", path: /^\/api\/connectors\/catalog$/ },
  { method: "GET", path: /^\/api\/connectors\/connected$/ },
  { method: "GET", path: /^\/api\/connectors$/ },
  { method: "POST", path: /^\/api\/connectors\/[\w-]+\/authorize$/ },
  { method: "DELETE", path: /^\/api\/connectors\/[\w-]+\/accounts\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/ },

  // Usage and cost, read-only.  The summary itself is computed on the phone
  // from the bots it already holds; these two add what only the harness knows:
  // quota windows, rolling per-engine spend and the engines it is holding back
  // (`quotas`), and the speech provider's character counts (`tts/usage`).
  // Neither carries a key or a token, and neither has a write side.
  { method: "GET", path: /^\/api\/quotas$/ },
  { method: "GET", path: /^\/api\/tts\/usage$/ },

  // Shared memory (the recall corpus) status, as one read-only row in
  // Settings.  Only the `qdrant` spelling: `/api/recall/status` is the same
  // handler under a second name and stays closed so there is one door.
  { method: "GET", path: /^\/api\/qdrant\/status$/ },

  // Background jobs: the list, one job's output, and Stop.  The owner approved
  // Stop and reading output from the phone (docs/plans/2026-10-01-background-
  // jobs-and-subagents-decision.md, ruling d).  Nothing here starts a job: a
  // job only starts from a bot's own tool call.  The bare `GET /api/jobs/:id`
  // and `/api/jobs/wake-usage` reads are used by no screen, so they stay
  // closed.  Ids are `[\w-]+`, the harness's own route pattern;  it checks the
  // `job_<ulid>` shape itself and answers 400 to anything else, so the sidecar
  // only has to keep a path from being smuggled in.  `stop` with no id is Stop
  // All for one conversation (`{ threadId }`), which the Mac's jobs menu has
  // too.
  { method: "GET", path: /^\/api\/jobs$/ },
  { method: "GET", path: /^\/api\/jobs\/[\w-]+\/output$/ },
  { method: "POST", path: /^\/api\/jobs\/[\w-]+\/stop$/ },
  { method: "POST", path: /^\/api\/jobs\/stop$/ },

  // A bot's imported Agent Skills: read the list, read one SKILL.md, and turn
  // one on or off, which is exactly what the Mac's Skills panel offers.
  // Importing is NOT here and must not be: `POST /api/bots/:id/skills` can read
  // a folder off the Mac's own disk, and the only thing standing between a
  // caller and that read is "the connection is loopback", which the sidecar
  // is.  There is no delete on the Mac's panel, so there is none here.  Skill
  // names are the harness's own `[a-z0-9-]+`.
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/skills$/ },
  { method: "GET", path: /^\/api\/bots\/[\w-]+\/skills\/[a-z0-9-]+$/ },
  { method: "PATCH", path: /^\/api\/bots\/[\w-]+\/skills\/[a-z0-9-]+$/ },
];

/** Route families worth naming in the refusal.
 *
 * Everything not allowed is denied either way; this only decides whether the
 * person gets a sentence or a 404. These are the ones someone might
 * reasonably expect to work from the phone, where "no route" would read as a
 * bug in the companion rather than a decision about where host configuration
 * happens. Order matters only in that the first match wins. */
const EXPLAINED: ReadonlyArray<{ path: RegExp; error: string }> = [
  {
    path: /^\/api\/(companion|devices)(\/|$)/,
    // Losing the phone must not mean losing the ability to lock it out.
    error: "Phone settings are managed on your computer",
  },
  { path: /^\/api\/config$/, error: "API keys can only be changed on your computer" },
  {
    // Which computers every bot may use is a grant, not a preference.  Its
    // sibling `apply-model-defaults` is allowed above.
    path: /^\/api\/bots\/apply-defaults$/,
    error: "computer defaults for every bot are set on your computer",
  },
  { path: /^\/api\/local-computer(\/|$)/, error: "the Local VM is set up on your computer" },
  {
    // Creating one exposes an endpoint to the internet, and rotating a
    // secret breaks whatever was sending to it. Neither belongs on a device
    // that lives in a pocket.
    path: /^\/api\/webhooks(\/|$)/,
    error: "webhooks are set up on your computer",
  },
  {
    path: /^\/api\/resource-triggers(\/|$)/,
    error: "resource triggers are set up on your computer",
  },
  // Listing, authorizing and detaching are allowed above.  What is left is
  // the bare per-connector DELETE, which removes a whole integration rather
  // than one account.
  { path: /^\/api\/connectors(\/|$)/, error: "removing a whole connected app is done on your computer" },
  {
    path: /^\/api\/routines(\/|$)/,
    error: "this routine operation is only available on your computer",
  },
  { path: /^\/api\/teams(\/|$)/, error: "teams are imported and exported on your computer" },
];

/** Why this request may not go through, or null when it may.
 *
 * Default deny: the answer for anything not on the list is "no route", which
 * is what keeps a stolen token from mapping the API. An allowlist rather than
 * a blocklist is the property this whole module exists for, and the one that
 * quietly stopped being true once before. */
export function denyReason({ path, method, authenticated }: RouteRequest): Denial | null {
  // Pairing is the one thing a device does before it has a credential.
  if (method === "POST" && path === "/api/pair") return null;
  // Liveness is the other: it exists to be the first thing anyone curls when
  // pairing will not work, and behind the token check it answered 401 to
  // exactly the person it was for — which reads as "broken" rather than
  // "unpaired". It discloses nothing a port scan would not.
  if (method === "GET" && path === "/api/health") return null;

  if (!authenticated) {
    return { status: 401, error: "pair this device from Phone settings in BotFleet on your computer" };
  }

  if (ALLOWED.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };

  // Everything else, including routes the harness really does have. Saying
  // "no route" rather than "not allowed" keeps the sidecar from enumerating
  // the API to anyone holding a stolen token — and it is what the peer-agent
  // endpoints under /api/internal/ always got, since off this machine they
  // genuinely do not exist.
  return { status: 404, error: `no route: ${method} ${path}` };
}
