// Reading a failed CUA desktop probe without lying about it.
//
// Both the Local VM (container-computer.ts) and the Self-Hosted VPS
// (vps-computer.ts) probe the in-container CUA Driver, and when the probe
// fails they look at the supervisor's stderr log for the reason.  That log is
// not an error log in the usual sense: a healthy Driver writes its update
// notice, its tracing output (INFO and WARN lines, with ANSI colour) and its
// "daemon listening" line to stderr on every start.  Treating "anything in
// the log" as the failure made a working desktop read "failed to start", and
// when the log could not be fetched at all the raw "Docker-over-SSH command
// timed out" took its place.  One rule sorts both cases, in this order:
//
//   1. Real lines in the log (anything that is not known noise, after the
//      last readiness line) are the failure.
//   2. Otherwise a timeout or transport blip is "could not check right now",
//      never "failed to start".
//   3. Otherwise the probe's own message, with the same noise removed.
//   4. Otherwise nothing: the generic "not ready yet" copy applies.
import { stripVTControlCharacters } from "node:util";

const PROBLEM_TEXT_LIMIT = 320;

/** A bare SGR run such as `[2m` or `[33m` that lost its ESC byte on the way
 * through a log viewer or a copy.  Digits and `m` only, so a JSON array or a
 * bracketed word can never match. */
const ORPHAN_SGR = /\[\d{1,3}(?:;\d{1,3}){0,4}m/g;

/** Remove terminal colour and cursor sequences.  Anything a person reads must
 * go through this: the Driver colours its tracing output, and ESC is invisible
 * in the UI while the `[2m` after it is not. */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text).replace(ORPHAN_SGR, "");
}

/** One line of problem text that is safe to show: no escape codes, whitespace
 * collapsed, bounded. */
export function problemText(text: string, max = PROBLEM_TEXT_LIMIT): string {
  return stripAnsi(text).replace(/\s+/g, " ").trim().slice(0, max);
}

/** The Driver prints this once its socket is bound. */
const READY_LINE = /\bdaemon listening on\b/i;
/** tracing's default format: an optional RFC 3339 timestamp, then the level. */
const TRACING_NOISE = /^(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:TRACE|DEBUG|INFO|WARN(?:ING)?)\b/;
/** The update notice a pinned Driver prints when a newer release exists
 * ("cua-driver v0.34.0 is available (you have v0.20.0)"), its two follow-up
 * lines, and the first-run telemetry notice.  None of them is a fault. */
const BANNER_NOISE =
  /^(?:cua-driver v\d[\w.+-]* is available\b|Update with:|Release notes:|Cua Driver sends content-free product telemetry\b)/i;

/** The lines of a Driver log that describe a real fault: empty when the log is
 * only banner, tracing below ERROR, and readiness.  Only lines after the LAST
 * readiness line count, because the supervisor restarts the daemon and a fault
 * before a later "listening" has already been recovered from.  Unrecognised
 * lines are kept: the rule is "drop what is known to be noise", so a plain
 * message from the start script still surfaces. */
export function realDriverProblems(text: string): string {
  const lines = stripAnsi(text).split(/\r?\n/).filter((line) => line.trim() !== "");
  let start = 0;
  lines.forEach((line, index) => {
    if (READY_LINE.test(line)) start = index + 1;
  });
  const real: string[] = [];
  let inNoise: boolean = false;
  for (const raw of lines.slice(start)) {
    const line = raw.trim();
    // An indented line straight after noise is that noise wrapping, not news.
    const continuation: boolean = inNoise && /^\s/.test(raw);
    inNoise = TRACING_NOISE.test(line) || BANNER_NOISE.test(line) || continuation;
    if (!inNoise) real.push(line);
  }
  return problemText(real.join(" "));
}

/** The `ssh` and runner failures that say the check never reached the
 * container, as opposed to the Driver answering badly.  Deliberately narrow:
 * a bare "connection refused" from `cua-driver status --socket` means the
 * daemon is down, which is a real fault. */
const TRANSPORT_FAILURE =
  /Docker-over-SSH command timed out|\bssh: connect to host\b|\bkex_exchange_identification\b|\bConnection (?:timed out|reset by peer|closed by)\b|\bBroken pipe\b|\bCould not resolve hostname\b|\bOperation timed out\b/i;

/** Did the probe fail because the check itself could not complete?  The VPS
 * runner words its own timeout; the Local VM runner is `execFile`, whose
 * timeout kills the child and reports `killed`/`signal` with a "Command
 * failed:" message that never says "timed out", so that case reads the error
 * fields rather than the text. */
export function isTransientProbeFailure(error: ExecFailure): boolean {
  if (error.killed === true || error.code === "ETIMEDOUT") return true;
  return TRANSPORT_FAILURE.test(error.message);
}

/** An Error as a runner rejects with it: `execFile` adds `killed` and `code`
 * to the Error it throws, and the VPS runner adds nothing.  Both are optional,
 * so any Error is one. */
export type ExecFailure = Error & { killed?: boolean; code?: string | number | null };

export interface DesktopProbeVerdict {
  /** A real fault to show after "failed to start", or null. */
  desktopError: string | null;
  /** The check could not complete this time; the desktop's state is unknown. */
  unreachable: boolean;
}

/** Decide what a failed desktop probe means.  `supervisorLog` is the tail of
 * the Driver's stderr log, or null when it could not be read. */
export function judgeDesktopProbeFailure(error: ExecFailure, supervisorLog: string | null): DesktopProbeVerdict {
  const fromLog = supervisorLog ? realDriverProblems(supervisorLog) : "";
  if (fromLog) return { desktopError: fromLog, unreachable: false };
  if (isTransientProbeFailure(error)) return { desktopError: null, unreachable: true };
  return { desktopError: realDriverProblems(error.message) || null, unreachable: false };
}
