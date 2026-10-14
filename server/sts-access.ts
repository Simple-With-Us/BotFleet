// What a caller may be told about speech-to-speech, and when.
//
// The rule this protects: the harness holds both provider keys and the phone
// holds none, so a client can only ever receive a short-lived token minted
// here.  Nothing in this module returns, logs, or hints at a permanent key.

import { z } from "zod";

import {
  pickStsProvider,
  STS_PROVIDERS,
  type StsChoiceReason,
  type StsKeyStatus,
  type StsProvider,
} from "../shared/sts-tokens.ts";

/** Reads a provider key out of the config without ever copying it anywhere
 *  the client can see.  `null` means "not configured", which is different
 *  from "we could not tell" and is reported differently. */
export type CredentialReader = (provider: StsProvider) => string | undefined;

/**
 * Whether each provider is usable right now.
 *
 * `null` for the whole status means "could not read the keys" -- a failed
 * probe, a locked keychain.  It is deliberately not the same as two falses,
 * because telling someone their key is missing when the read failed sends
 * them to Settings to add a key they already have.
 */
export function stsKeyStatus(read: CredentialReader): StsKeyStatus | null {
  try {
    return { xai: Boolean(read("xai")), gemini: Boolean(read("gemini")) };
  } catch {
    return null;
  }
}

/** One sentence a person can act on, or null when there is nothing to say. */
export interface StsRefusal {
  status: number;
  error: string;
}

/** The request body the token route accepts.  Parsed here, at the door, so
 *  the policy below works on a domain value and never on raw JSON. */
// SAFETY: `STS_PROVIDERS` is declared `readonly StsProvider[]` above and
// holds exactly the two literals `StsProvider` names, so it satisfies the
// non-empty tuple z.enum requires. The cast is the widening z.enum wants,
// not a claim about input.
const STS_PROVIDER_TUPLE: [StsProvider, StsProvider] = [STS_PROVIDERS[0], STS_PROVIDERS[1]];

export const stsTokenRequest = z.object({ provider: z.enum(STS_PROVIDER_TUPLE) });
export type StsTokenRequest = z.infer<typeof stsTokenRequest>;

/** GET /api/sts/status when the keys could be read.
 *
 *  The two booleans, plus the provider a call would use.  Strict, because
 *  this object is the whole answer: an extra field would be a key or a
 *  token, and neither may cross this route.  The type is inferred from the
 *  schema so a hand-written mirror cannot drift from the parser. */
export const StsStatusSchema = z
  .object({
    xai: z.boolean(),
    gemini: z.boolean(),
    provider: z.enum(STS_PROVIDER_TUPLE).nullable(),
  })
  .strict();
export type StsStatus = z.infer<typeof StsStatusSchema>;

/** Error JSON the STS routes answer with.  `.passthrough()` because a
 *  failure may carry fields beyond `error` without changing the sentence
 *  the caller reads. */
export const StsErrorBodySchema = z.object({ error: z.string() }).passthrough();
export type StsErrorBody = z.infer<typeof StsErrorBodySchema>;

/** Which provider a call would use, and why.  Mirrors the desktop's
 *  `pickStsProvider` so a phone and the web client degrade identically. */
export interface StsResolution {
  provider: StsProvider | null;
  reason: StsChoiceReason | "unknown";
}

export function stsUnavailableReason(requested: StsProvider | null, keys: StsKeyStatus | null): StsRefusal | null {
  if (keys === null) {
    // Not "no key": we could not read them.
    return { status: 503, error: "Could not read the voice provider keys on this computer." };
  }
  if (!requested) {
    return { status: 400, error: "Unknown speech-to-speech provider." };
  }
  if (keys[requested]) return null;
  const label = requested === "xai" ? "xAI API key" : "Google Gemini API key";
  return {
    status: 409,
    error: `No ${label} on this computer.  Add one in BotFleet on your Mac, or pick the other provider.`,
  };
}

/** The provider a call should actually use, and why. */
export function resolveStsProvider(keys: StsKeyStatus | null, preference: StsProvider | null): StsResolution {
  if (keys === null) return { provider: null, reason: "unknown" };
  return pickStsProvider(keys, preference);
}

/** The 200 body of GET /api/sts/status.  Built from the policy above and
 *  parsed through `StsStatusSchema`, so the route cannot publish a shape
 *  the schema would refuse. */
export function stsStatusBody(keys: StsKeyStatus, preference: StsProvider | null): StsStatus {
  return StsStatusSchema.parse({
    xai: keys.xai,
    gemini: keys.gemini,
    provider: resolveStsProvider(keys, preference).provider,
  });
}

/** A client may not mint tokens back to back.  Each mint is a real request to
 *  a paid vendor endpoint, so an unthrottled loop from a paired device is a
 *  way to spend someone's quota.  One token per provider per window. */
export class StsMintThrottle {
  // Explicit fields, not constructor parameter properties: the harness boots
  // under `node --experimental-strip-types`, which runs in *strip-only* mode
  // and refuses parameter property shorthand.  `now` is injectable so tests
  // can drive the clock deterministically.
  private readonly last = new Map<StsProvider, number>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    windowMs: number = 10_000,
    now: () => number = () => Date.now(),
  ) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** True when this provider may mint now, and records the attempt. */
  take(provider: StsProvider): boolean {
    const at = this.now();
    const previous = this.last.get(provider);
    if (previous !== undefined && at - previous < this.windowMs) return false;
    this.last.set(provider, at);
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}