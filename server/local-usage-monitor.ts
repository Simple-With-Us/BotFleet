import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteQuotaWindow } from "./usage-quota.ts";
import { canonicalQuotaProvider, isSupportedQuotaProvider, NEAR_CAP_PERCENT } from "./quota-window-map.ts";
import type { JsonValue, JsonObject } from "./schema.ts";

const MAX_BYTES = 1_048_576;
/** The producer rewrites the handoff every 300 seconds, at launch and on
 *  system wake.  Anything inside three of those cycles is a live reading;
 *  past that the writer has missed two in a row, which is the point where
 *  the app is more likely gone than slow.  The previous ten-minute window
 *  allowed exactly one missed cycle, so one slow provider read could empty
 *  the quota grid with nothing said about why. */
export const LOCAL_QUOTA_WRITE_INTERVAL_MS = 5 * 60_000;
export const LOCAL_QUOTA_MAX_AGE_MS = 3 * LOCAL_QUOTA_WRITE_INTERVAL_MS;
/** An absolute allowance large enough for any real plan and small enough to
 *  reject a nonsense reading — the same shape of bound `remainingPercent`
 *  gets, applied to a figure with no natural ceiling. */
const MAX_ABSOLUTE = 1e12;
const FILE_STATUSES = new Set(["available", "near_cap", "exhausted", "unknown"]);
const record = (value): Record<string, JsonValue> | null =>
  value !== null && (Object.prototype.toString.call(value) === "[object Object]") && !Array.isArray(value) ? // SAFETY: the toString-call + !Array.isArray() guards restrict
    // value to a JSON object, so the cast to a record of JsonValue fields is exact.
    value as Record<string, JsonValue> : null;
const text = (value, max = 200): string | null =>
  (Object.prototype.toString.call(value) === "[object String]") && value.length <= max && !/[\x00-\x1f]/.test(value) ? value : null;
const timestamp = (value): string | null => {
  const valueText = text(value, 40);
  return valueText && Number.isFinite(Date.parse(valueText)) ? valueText : null;
};
/** Absolute figures are display extras, so a malformed one drops the field
 *  rather than the window: the percentage the row is really about has
 *  already passed the identical finite / non-negative / bounded check. */
const amount = (value): number | null =>
  (Object.prototype.toString.call(value) === "[object Number]") && Number.isFinite(value) && value >= 0 && value <= MAX_ABSOLUTE ? value : null;
const errorCode = (value): string => {
  const envelope = record(value);
  return envelope && (Object.prototype.toString.call(envelope.code) === "[object String]") ? envelope.code : "";
};

/** Why the quota grid is empty, so the UI can say so instead of showing
 *  nothing: a live file, one the producer stopped refreshing (with its age),
 *  no file at all, or a file that could not be read or understood. */
export type LocalQuotaFreshness =
  | { state: "fresh"; generatedAt: string; ageMs: number }
  | { state: "stale"; generatedAt: string; ageMs: number }
  | { state: "missing" }
  | { state: "unreadable" };

export type LocalQuotaSnapshot = {
  windows: RemoteQuotaWindow[];
  freshness: LocalQuotaFreshness;
  /** Which app wrote the handoff, when it says so.  Both keys are optional
   *  additions on an unchanged format/version, so an older writer that sends
   *  neither parses exactly as it always did. */
  producer: string | null;
  /** Provider key → the short, user-safe reason that provider could not be
   *  read, as the producer's own menu shows it.  A provider that fails has no
   *  windows at all, and without this it simply vanished from the grid. */
  issues: Record<string, string>;
};

/** Long enough for a real reason, short enough that a hostile or runaway
 *  string cannot take over the row.  It is rendered as text, never markup. */
const MAX_ISSUE_LENGTH = 160;
const MAX_ISSUES = 32;
/** What is worth folding down to a line at all; past this the value is not a
 *  reason someone wrote and is refused before any work is done on it. */
const MAX_REASON_LENGTH = 4_000;

/** A reason is prose the producer wrote for a person, so unlike an id or a
 *  label it may legitimately arrive wrapped over two lines.  Runs of
 *  whitespace fold to one space BEFORE the shared control-character check,
 *  so such a reason renders as one line instead of being dropped and leaving
 *  the engine's row saying nothing at all — the very thing this key exists to
 *  fix.  A control character is not whitespace and so survives the fold, and
 *  `text` still refuses it: that is not prose. */
function issueReason(value): string | null {
  if (!(Object.prototype.toString.call(value) === "[object String]") || value.length > MAX_REASON_LENGTH) return null;
  const message = text(value.replace(/\s+/g, " ").trim(), MAX_REASON_LENGTH);
  return message ? message.slice(0, MAX_ISSUE_LENGTH).trim() || null : null;
}

function parseQuotaIssues(value) {
  const raw = record(value);
  if (!raw) return {};
  const issues: Record<string, string> = {};
  for (const [key, reason] of Object.entries(raw).slice(0, MAX_ISSUES)) {
    if (!isSupportedQuotaProvider({ providerKey: key })) continue;
    const message = issueReason(reason);
    if (message) issues[canonicalQuotaProvider({ providerKey: key })] = message;
  }
  return issues;
}

const empty = (freshness: LocalQuotaFreshness): LocalQuotaSnapshot =>
  ({ windows: [], freshness, producer: null, issues: {} });

/** Same-user, quota-only cache from the native Usage Monitor app.
 *  The producer's own verdict travels as `isExhausted` / `fileSkip` /
 *  `fileStatus`; `status` and `skip` stay derived so every existing display
 *  path keeps the meaning it has always had. */
export function parseLocalQuotaPayload(value, now = Date.now()): LocalQuotaSnapshot {
  const payload = record(value);
  if (!payload || payload.format !== "usage-monitor-local-quotas" || payload.version !== 1) {
    return empty({ state: "unreadable" });
  }
  const generatedAt = timestamp(payload.generatedAt);
  if (!generatedAt || !Array.isArray(payload.windows) || payload.windows.length > 256) {
    return empty({ state: "unreadable" });
  }
  const producer = text(payload.producer, 40);
  const issues = parseQuotaIssues(payload.issues);
  const age = now - Date.parse(generatedAt);
  // A snapshot from the future is a clock the reader cannot reason about,
  // not a late one, so it reports as unreadable rather than as an age.
  if (age < -60_000) return empty({ state: "unreadable" });
  if (age >= LOCAL_QUOTA_MAX_AGE_MS) return { windows: [], freshness: { state: "stale", generatedAt, ageMs: age }, producer, issues };
  const windows: RemoteQuotaWindow[] = [];
  const seen = new Set<string>();
  for (const raw of payload.windows) {
    const row = record(raw);
    if (!row) continue;
    // Grok Bot is a different product from Grok CLI and cannot run in BotFleet.
    if (!isSupportedQuotaProvider({ provider: text(row.provider), providerKey: text(row.providerKey), via: text(row.via) })) continue;
    const provider = canonicalQuotaProvider({ provider: text(row.provider), providerKey: text(row.providerKey), via: text(row.via) });
    const id = text(row.id);
    const label = text(row.label);
    const occurredAt = timestamp(row.occurredAt);
    const percent = row.remainingPercent;
    if (!id || !label || !occurredAt || seen.has(`${provider}:${id}`)) continue;
    const observedAge = now - Date.parse(occurredAt);
    if (observedAge < -60_000 || observedAge >= LOCAL_QUOTA_MAX_AGE_MS) continue;
    if (percent !== undefined && percent !== null && (Object.prototype.toString.call(percent) !== "[object Number]" || !Number.isFinite(percent) || percent < 0 || percent > 100)) continue;
    const resetAt = timestamp(row.resetAt);
    const resetPassed = resetAt !== null && Date.parse(resetAt) <= now;
    const remainingPercent = row.remainingUnknown === true || resetPassed ? null : (Object.prototype.toString.call(percent) === "[object Number]") ? percent : null;
    const fileStatus = text(row.status, 20);
    seen.add(`${provider}:${id}`);
    windows.push({
      id, provider, providerKey: provider, providerLabel: text(row.providerLabel) ?? undefined,
      sourceApp: `usage-monitor-mac:${provider === "openai" ? "codex" : provider}`, via: text(row.via) ?? undefined,
      label, modelId: text(row.modelId), modelType: text(row.modelType) ?? "", window: text(row.window) ?? "",
      remainingPercent, resetAt, occurredAt, source: "Usage Monitor on this Mac",
      // Exactly the producer's own boundary: 0 is exhausted, and anything at
      // or below NEAR_CAP_PERCENT (20) is near its cap.  The row's own
      // `status` string travels beside this as `fileStatus`, so the two must
      // classify the same percentage the same way or the grid cell and the
      // handoff it came from would contradict each other.
      status: remainingPercent === null
        ? "unknown"
        : remainingPercent === 0
          ? "exhausted"
          : remainingPercent <= NEAR_CAP_PERCENT ? "near_cap" : "available",
      skip: false, skipReason: null,
      planName: text(row.planName, 60), quotaUnit: text(row.quotaUnit, 24),
      absoluteRemaining: amount(row.absoluteRemaining), absoluteLimit: amount(row.absoluteLimit),
      // Both cleared once the reset has passed, exactly as `remainingPercent`
      // above is: a verdict recorded before the boundary describes the period
      // that just ended, not the one now running.  The routing path already
      // refuses to cap on an end that is behind it (`localCooldownEnd`), and
      // the engine chip reads the blanked percentage, so leaving these two
      // set was the one thing that kept the Settings grid cell red under a
      // chip saying "Available" — for up to a full producer write cycle after
      // every reset.
      isExhausted: row.isExhausted === true && !resetPassed,
      fileStatus: fileStatus && FILE_STATUSES.has(fileStatus) ? fileStatus : null,
      fileSkip: row.skip === true && !resetPassed, fileSkipReason: text(row.skipReason),
    });
  }
  return { windows, freshness: { state: "fresh", generatedAt, ageMs: age }, producer, issues };
}

export function parseLocalQuotaSnapshot(value, now = Date.now()): RemoteQuotaWindow[] {
  return parseLocalQuotaPayload(value, now).windows;
}

export async function readLocalQuotaSnapshot(
  path = join(homedir(), "Library", "Application Support", "Usage Monitor", "quota-windows.json"),
  now = Date.now(),
): Promise<LocalQuotaSnapshot> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return empty({ state: "unreadable" });
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    // Windows lacks O_NOFOLLOW; reject links first and verify the opened identity.
    if (before.dev !== stat.dev || before.ino !== stat.ino) return empty({ state: "unreadable" });
    if (!stat.isFile() || stat.size > MAX_BYTES || (process.getuid && stat.uid !== process.getuid())) {
      return empty({ state: "unreadable" });
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size <= MAX_BYTES) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) return empty({ state: "unreadable" });
    return parseLocalQuotaPayload(JSON.parse(buffer.toString("utf8", 0, size)), now);
  } catch (error) {
    // An unopened or uninstalled native app is an ordinary absence of data;
    // anything else is a file that exists and could not be read.
    return empty({ state: errorCode(error) === "ENOENT" ? "missing" : "unreadable" });
  } finally {
    await file?.close().catch(() => {});
  }
}

/** A local account is one identity boundary; never borrow another account's
 *  weekly cap from the remote server to fill its missing local period. */
export function mergeLocalQuotaWindows(remote: RemoteQuotaWindow[], local: RemoteQuotaWindow[]): RemoteQuotaWindow[] {
  const localProviders = new Set(local.map((row) => canonicalQuotaProvider(row)));
  const remoteProviders = new Set(remote.filter((row) => !localProviders.has(canonicalQuotaProvider(row))).map((row) => canonicalQuotaProvider(row)));
  return [
    ...local.filter((row) => !remoteProviders.has(canonicalQuotaProvider(row))),
    ...remote.filter((row) => !localProviders.has(canonicalQuotaProvider(row))),
  ];
}
