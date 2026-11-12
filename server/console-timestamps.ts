// The harness runs under launchd with stdout and stderr piped to one
// shared, unrotated log file that also carries the companion sidecar's
// lines.  The companion timestamps its own lines; the harness's `[telemetry]`,
// `[antigravity-quota]`, `[infisical]` and every other bracket-tagged line do
// not, so nothing in `server.log` can be correlated across subsystems by
// time (OP7).  Installed once at boot, before any other logging in
// `server/index.ts`, this prefixes every `console.log/info/warn/error` line
// with an ISO timestamp — but only when stdout is not a TTY, so an
// interactive dev terminal (where a human is reading it live, and where the
// terminal itself already shows wall-clock context) is left alone.

const TIMESTAMPED_METHODS = ["log", "info", "warn", "error"] as const;
type TimestampedMethod = (typeof TIMESTAMPED_METHODS)[number];

let installed = false;

/** An interactive dev terminal doesn't need the prefix; the headless
 * launchd path — where lines land in a shared, unrotated file next to
 * already-timestamped companion lines — is exactly the case this exists
 * for. */
function shouldTimestamp(): boolean {
  return process.stdout.isTTY !== true;
}

/** The companion sidecar already timestamps its own lines with a leading
 * `[20…` (an ISO year).  Prefixing those again would make every
 * already-correlatable line harder to read for no benefit. */
function alreadyTimestamped(line: string): boolean {
  return line.startsWith("[20");
}

function prefixLine(line: string): string {
  if (alreadyTimestamped(line)) return line;
  return `[${new Date().toISOString()}] ${line}`;
}

/** Idempotent: a second call (a test, a hot-reloaded module) is a no-op
 * rather than double-wrapping `console.log` and printing two timestamps
 * per line. */
export function installTimestampedConsole(): void {
  if (installed) return;
  installed = true;
  if (!shouldTimestamp()) return;
  for (const method of TIMESTAMPED_METHODS) {
    const original = console[method].bind(console);
    // SAFETY: every member of TIMESTAMPED_METHODS is a `(...data: unknown[])
    // => void` console method, so a same-shaped wrapper is a valid
    // replacement for the one it closed over above.
    console[method] = ((...args: unknown[]) => {
      if (typeof args[0] === "string") {
        original(prefixLine(args[0]), ...args.slice(1));
      } else {
        original(...args);
      }
    }) as Console[TimestampedMethod];
  }
}

/** Test-only escape hatch: lets a test install a fresh wrapper after
 * resetting `console` between cases.  Production never calls this. */
export function resetTimestampedConsoleForTests(): void {
  installed = false;
}
