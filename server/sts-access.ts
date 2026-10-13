// What a caller may be told about speech-to-speech, and when.
//
// The rule this protects: the harness holds both provider keys and the phone
// holds none, so a client can only ever receive a short-lived token minted
// here.  Nothing in this module returns, logs, or hints at a permanent key.

import { isStsProvider, pickStsProvider, type StsKeyStatus, type StsProvider } from "../shared/sts-tokens.ts";

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
export function stsUnavailableReason(
  requested: unknown,
  keys: StsKeyStatus | null,
): { status: number; error: string } | null {
  if (keys === null) {
    // Not "no key": we could not read them.
    return { status: 503, error: "Could not read the voice provider keys on this computer." };
  }
  if (!isStsProvider(requested)) {
    return { status: 400, error: "Unknown speech-to-speech provider." };
  }
  if (keys[requested]) return null;
  const label = requested === "xai" ? "xAI API key" : "Google Gemini API key";
  return {
    status: 409,
    error: `No ${label} on this computer.  Add one in BotFleet on your Mac, or pick the other provider.`,
  };
}

/** The provider a call should actually use, and why.  Mirrors the desktop's
 *  `pickStsProvider` so a phone and the web client degrade identically. */
export function resolveStsProvider(
  keys: StsKeyStatus | null,
  preference: unknown,
): { provider: StsProvider | null; reason: string } {
  if (keys === null) return { provider: null, reason: "unknown" };
  const wanted = isStsProvider(preference) ? preference : null;
  return pickStsProvider(keys, wanted);
}

/** A client may not mint tokens back to back.  Each mint is a real request to
 *  a paid vendor endpoint, so an unthrottled loop from a paired device is a
 *  way to spend someone's quota.  One token per provider per window. */
export class StsMintThrottle {
  private readonly last = new Map<StsProvider, number>();

  constructor(
    private readonly windowMs = 10_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

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