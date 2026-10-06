// Ask a local, already-checksum-verified native executable for its version
// without ever mistaking a busy machine for a bad download.
//
// Lives under electron/ so the packaged app can import it from app.asar.
// Packaging scripts re-export this module from scripts/native-version-probe.mjs.
//
// The rules, all of them load-bearing:
//   - a timeout is a statement about the host, never about the binary, and is
//     reported as such;
//   - only a timeout is retried, because only a timeout can succeed a second
//     later -- a missing file, a non-executable bit, and a real version
//     mismatch are all deterministic;
//   - the failure message carries the evidence (`status`, `signal`, the spawn
//     error, a capped output excerpt) so the reader can tell the four failure
//     modes apart instead of hunting for a corrupt download that does not
//     exist.

import { spawnSync } from "node:child_process";

/** `cloudflared version` runs in ~0.2s warm / ~1.5s cold, so the original 10s
 * looked generous.  It is not: a child waiting for a CPU on a saturated host
 * can miss any short window, and the old ceiling turned a slow machine into a
 * red build.  Sixty seconds keeps the warm path instant and spends patience
 * only where waiting can actually help. */
export const NATIVE_PROBE_TIMEOUT_MS = 60_000;
export const NATIVE_PROBE_ATTEMPTS = 2;

/** Enough to identify the line that mattered, short enough that a chatty
 * binary cannot bury the real error. */
export const PROBE_DETAIL_LIMIT = 200;

export function oneLine(value, limit = PROBE_DETAIL_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The four ways a probe can fail, plus the one way it succeeds.  A timeout
 * arrives as `error.code === "ETIMEDOUT"` with the child already killed, so
 * `status` is null and `signal` is set -- none of which a single boolean can
 * tell apart from a genuine mismatch. */
export function classifyNativeProbe(result = {}, matchVersion) {
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (result.error) {
    const message = String(result.error.message ?? result.error);
    const timedOut = result.error.code === "ETIMEDOUT" || /ETIMEDOUT/i.test(message);
    return { ok: false, reason: timedOut ? "timeout" : "spawn", version: null };
  }
  if (result.status === 0) {
    // Prefer stdout; fall back to stderr — some natives print --version there.
    // Callers still match lines (not whole-buffer equality), so a glibc banner
    // on the other stream cannot fake a pin.
    const version = matchVersion(stdout) || matchVersion(stderr);
    return version
      ? { ok: true, reason: "version", version }
      : { ok: false, reason: "version", version: null };
  }
  if (result.signal) return { ok: false, reason: "signal", version: null };
  return { ok: false, reason: "status", version: null };
}

/** Run the probe, retrying only a timeout.  Returns the same shape for a
 * success and for every failure so the caller never has to branch on which
 * kind of answer it got before it can build a useful message. */
export function probeNativeVersion(binary, options = {}) {
  const {
    args = ["version"],
    matchVersion,
    spawn = spawnSync,
    spawnOptions = {},
    timeoutMs = NATIVE_PROBE_TIMEOUT_MS,
    attempts = NATIVE_PROBE_ATTEMPTS,
    log = console.error,
    probeLabel = "version probe",
  } = options;
  if (!(matchVersion instanceof Function)) {
    throw new TypeError("probeNativeVersion requires a matchVersion function");
  }
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawn(binary, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      ...spawnOptions,
    });
    last = { ...classifyNativeProbe(result, matchVersion), result, attempt, attempts, timeoutMs };
    if (last.ok) return last;
    if (last.reason !== "timeout" || attempt === attempts) break;
    log(
      `${probeLabel} for ${binary} timed out after ${Math.round(timeoutMs / 1000)}s — retrying ` +
        `(attempt ${attempt + 1} of ${attempts})`,
    );
  }
  return last;
}

/** Same retry and classification rules as `probeNativeVersion`, exposed under the
 * name call sites use when replacing `execFileSync` / `spawnSync` directly. */
export const probeNativeSync = probeNativeVersion;

const CAUSES = {
  timeout: (probe) =>
    `the version probe timed out on attempt ${probe.attempt} of ${probe.attempts} ` +
    `at ${Math.round(probe.timeoutMs / 1000)}s each`,
  spawn: () => "the executable could not be run",
  signal: (probe) => `the version probe was killed by ${probe.result.signal}`,
  status: (probe) => `the version probe exited with status ${probe.result.status}`,
  version: () => "it ran but did not report the expected version",
  missing: () => "there was no executable to run",
};

/** `summary` is the caller's own sentence, passed in whole so an existing
 * message that people have already read in logs and board history keeps
 * matching verbatim; this only appends the cause and the evidence.  `causes`
 * overrides individual wordings for callers whose subject is not a generic
 * "expected version" (cloudflared says "the pinned version"). */
export function nativeProbeFailureMessage(summary, probe = {}, { causes = {} } = {}) {
  const { result = {} } = probe;
  const table = { ...CAUSES, ...causes };
  const cause = table[probe.reason]?.(probe) ?? "the version probe did not complete";
  const details = [`status=${result.status ?? "null"}`, `signal=${result.signal ?? "none"}`];
  if (result.error) details.push(`error=${oneLine(result.error.message, 160)}`);
  const output = oneLine([result.stdout, result.stderr].filter(Boolean).join(" "));
  if (output) details.push(`output=${output}`);
  return `${summary} (${cause}; ${details.join("; ")})`;
}
