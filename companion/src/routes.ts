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
 * included: the native model picker is a companion feature.  Execution
 * policy, connected apps, computer grants, and host paths remain Mac-only. */
export const COMPANION_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  "speakReplies",
  "speechDevices",
  "modelSelection",
] as const;

const COMPANION_PROFILE_PATCH_FIELD_SET = new Set<string>(COMPANION_PROFILE_PATCH_FIELDS);

export function isCompanionProfilePatch(method: string, path: string): boolean {
  return method === "PATCH" && /^\/api\/bots\/[\w-]+\/profile$/.test(path);
}

/** Validate the paired-device field boundary before a profile body reaches
 * the broader loopback harness route.  Reject the whole request rather than
 * silently stripping a field the person expected to save. */
export function companionProfilePatchDenial(body: Record<string, unknown>): Denial | null {
  const unsupported = Object.keys(body).find((field) => !COMPANION_PROFILE_PATCH_FIELD_SET.has(field));
  return unsupported
    ? { status: 403, error: `${unsupported} can only be changed in BotFleet on your computer` }
    : null;
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
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/avatar\/generate$/ },
  // Full cloud desktop access. The route is narrow and the proxy applies a
  // second, per-device capability check before it reaches the harness.
  CLOUD_DESKTOP_JOIN_ROUTE,

  // rooms — making one, and talking in one
  { method: "POST", path: /^\/api\/groups$/ },
  { method: "PATCH", path: /^\/api\/groups\/[\w-]+$/ },
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
  { method: "GET", path: /^\/api\/search$/ },

  // App-owned profile images. Upload is image-only and capped at 10 MB by
  // the harness; GET is a single bare generated filename, never a path.
  { method: "POST", path: /^\/api\/attachments$/ },
  { method: "GET", path: /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i },

  // Renderer-neutral voice operations. Neither route reads or writes the
  // workspace MiniMax key; the phone receives labels or audio only.
  { method: "GET", path: /^\/api\/tts\/voices$/ },
  { method: "POST", path: /^\/api\/tts\/speak$/ },
  { method: "POST", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/audio\/\d+$/ },

  // Routines create ordinary tasks using an existing agent configuration.
  // Webhook management remains explicitly denied below.
  { method: "GET", path: /^\/api\/routines$/ },
  { method: "POST", path: /^\/api\/routines$/ },
  { method: "PATCH", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "DELETE", path: /^\/api\/routines\/[\w-]+$/ },
  { method: "POST", path: /^\/api\/routines\/[\w-]+\/run$/ },

  // Checking for a newer BotFleet and installing it.  The phone is the one
  // place an update is convenient to start — the Mac is usually mid-work when
  // someone notices a build is stale.  `POST /api/update/run` takes the same
  // runtime-readiness reading `POST /api/runtime/quiesce` takes and answers
  // 409 while any turn, queued send or routine run is in flight, so a tap
  // from a pocket does not interrupt work; `{ "force": true }` talks past
  // that check, and the updater's own preflight then refuses instead.
  // `status` is a read; `check` and `run` are the two actions.
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
