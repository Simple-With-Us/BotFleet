// Whether the sidecar's device port is reachable from off this machine, and
// what it costs to say yes.
//
// The threat model, stated once, because everything else here follows from it.
// `:8810` speaks plain HTTP. Everything a phone sends and everything it gets
// back is on the wire in the clear: the one-time pairing credential in the
// request, the bearer token minted in the 201, and every transcript frame of
// every turn after that. The allowlist and the token check on the far side of
// that socket protect a *paired* phone from a stolen token — they do nothing
// about the first bytes of the conversation, which are already on the wire
// before either of them runs. On a network the owner does not control that is
// a passive read of everything the bot said, not a break-in, which is why it
// is worth fixing rather than documenting.
//
// The two fixes that actually close it are both out of reach from here. A
// self-signed certificate pinned in the pairing QR is the real answer, and it
// needs a matching iOS change first: a phone that cannot verify a certificate
// must not be told to trust one the machine it is talking to minted, or the
// QR becomes a downgrade to any attacker who stands in the middle. And "do not
// listen on the LAN at all" is only acceptable if something else still
// carries a pairing.
//
// So the default is the part that is available, and it is the part that
// answers the audit's question honestly: a fresh install is NOT plaintext on
// the LAN. The device port binds loopback and stays there until someone says
// otherwise in a way that cannot happen by accident, because the hosted HTTPS
// route is the supported way for a phone to reach a paired computer and it
// tunnels to this very port.
//
// The opt-in is an environment variable because that is the one channel a
// person starting a process deliberately holds: there is no file to edit, no
// database row, and no value that a later code change can quietly default to
// "on". Only the literal words below count as consent — anything else is
// treated as not given, and reported as not given, so a typo cannot open the
// port while looking like it tried to close it.

/** The environment variable that reopens the device port to the LAN. */
export const CLEARTEXT_LAN_ENV = "OMB_COMPANION_ALLOW_CLEARTEXT_LAN";

export type LanPolicySource = "default" | "env" | "invalid";

export interface LanPolicy {
  /** Does the device port bind a routable address? */
  readonly allowCleartextLan: boolean;
  /** The address the device port binds.  `0.0.0.0` is the whole question. */
  readonly deviceBindHost: "0.0.0.0" | "127.0.0.1";
  /** How the answer was reached, so a refusal can name the reason. */
  readonly source: LanPolicySource;
}

/** The policy for an install that configured nothing. */
export const DEFAULT_LAN_POLICY: LanPolicy = {
  allowCleartextLan: false,
  deviceBindHost: "127.0.0.1",
  source: "default",
};

/** Read the opt-in.  Only an affirmative word is consent.
 *
 * Deliberately narrow: `on`, `yes`, `enabled` and a stray space are all
 * "not given".  A setting whose default on a typo is the insecure one is a
 * setting nobody should ship, and the cost of a refused flag here is a
 * sentence on a console nobody reads. */
export function readLanPolicy(
  value: string | undefined = process.env[CLEARTEXT_LAN_ENV],
): LanPolicy {
  const given = value?.trim().toLowerCase();
  if (given === undefined || given === "") return DEFAULT_LAN_POLICY;
  if (given === "1" || given === "true") {
    return { allowCleartextLan: true, deviceBindHost: "0.0.0.0", source: "env" };
  }
  return { allowCleartextLan: false, deviceBindHost: "127.0.0.1", source: "invalid" };
}

/** Does a Bonjour record make sense for this policy?
 *
 * Multicast DNS is a LAN protocol — there is no way to publish a record that
 * only the loopback interface can see.  So with the device port bound to
 * loopback, a record would advertise a port that refuses every connection
 * that follows it, which is worse than no record: the phone walks its way
 * through the list it was given and fails on a route that was never going to
 * work.  A refusal the operator can see beats a discovery entry that lies. */
export const advertisesOnLan = (policy: LanPolicy): boolean => policy.allowCleartextLan;

/** The route kinds a phone dials that reach this machine directly, over the
 * local network, in cleartext.  A `hosted` route is deliberately absent: it is
 * a public HTTPS origin whose connector lands on this loopback port, so it
 * keeps working when the port does not leave the machine. */
export const DIRECT_LAN_ROUTE_KINDS: ReadonlySet<string> = new Set(["lan", "bonjour", "tailnet"]);

export interface RoutableCandidate {
  url: string;
  kind: string;
}

/** Keep the candidates this policy can actually serve.
 *
 * Filtering here rather than in the caller is the point: every list of routes
 * a phone is handed — the Bonjour-adjacent host list, the pairing response,
 * the control page — goes through one of these two functions, and a route the
 * sidecar cannot answer is a route that costs a phone its whole connection
 * walk. */
export function reachableCandidates<T extends RoutableCandidate>(
  candidates: readonly T[],
  policy: LanPolicy,
): T[] {
  return policy.allowCleartextLan
    ? [...candidates]
    : candidates.filter((candidate) => !DIRECT_LAN_ROUTE_KINDS.has(candidate.kind));
}

/** One line naming the posture, for the startup banner. */
export function lanPolicySummary(policy: LanPolicy, port: number): string {
  return policy.allowCleartextLan
    ? `the device port is open on the LAN in cleartext on port ${port} — pairing credentials, bearer tokens and transcripts cross the network unencrypted`
    : `the device port binds loopback only; a phone cannot reach it over the LAN in cleartext`;
}

/** The two ways forward when the port is loopback-only, in the order worth
 * trying.  Named exactly, because a refusal nobody can act on is the same as
 * an outage from where the phone sits. */
export function lanPolicyAdvice(policy: LanPolicy, hostedUrl: string | null): string[] {
  if (policy.allowCleartextLan) return [];
  const lines = [
    `pair over HTTPS instead: set OMB_COMPANION_HOSTED_URL to a public HTTPS origin (currently ${hostedUrl ?? "not set"})`,
  ];
  if (!hostedUrl) {
    lines.push(
      `to accept cleartext on your own network anyway: ${CLEARTEXT_LAN_ENV}=1`,
    );
  }
  return lines;
}

/** A refusal that says WHY, for the pairing page and the startup banner.
 *
 * The three reasons are kept apart because they call for different actions,
 * and a page that only said "disabled" would leave an operator who had
 * deliberately set the flag hunting for a setting that is already set. */
export function lanPolicyNote(policy: LanPolicy): string | null {
  if (policy.allowCleartextLan) return null;
  if (policy.source === "invalid") {
    return (
      `The device port is loopback only: ${CLEARTEXT_LAN_ENV} was set to a value that is not consent. ` +
      `Use 1 to allow cleartext on your own network.`
    );
  }
  return (
    "The device port is loopback only, so a phone pairs over HTTPS rather than in cleartext on your network. " +
    `Set ${CLEARTEXT_LAN_ENV}=1 to allow cleartext on a network you control.`
  );
}
