import { botDesktopSession } from "./bot-desktop-session.ts";
import { CUA_EXECUTABLE, cuaExecArgs, defaultCommandRunner, type CommandRunner } from "./container-computer.ts";
import type { BotDesktopSession } from "./bot-desktop-session.ts";
import type { AppConfig } from "./config.ts";

/** Per-bot desktop identity inside the ONE shared Local VM container.
 *
 * This mirrors Cloud VPS shared mode: the container is shared, the desktop is
 * not.  Each bot gets its own Xvfb display, its own Cua socket and its own
 * screenshot path, so N bots can drive the same container concurrently.
 *
 * The `:1` desktop stays exactly as the supervisor started it — that is the
 * human noVNC preview, a single observer by design — and nothing here touches
 * it. */
export type LocalVmSharedBotSession = BotDesktopSession;

export function isSharedLocalVmMode(cfg: AppConfig): boolean {
  return cfg.localVm?.mode === "shared";
}

/** Lease lane for a bot in shared mode.
 *
 * Deliberately NOT the container key: `key` still identifies the one shared
 * container (lifecycle, idle teardown and the `remove` action must keep seeing
 * a single desktop), while this lane is what makes each bot's turn its own. */
export function localVmSharedLaneKey(botId: string): string {
  return `localvm-bot:${botDesktopSession(botId, "local-vm").short}`;
}

/** Deterministic display + Cua socket + screenshot path for one bot. */
export function localVmSharedBotSession(botId: string): LocalVmSharedBotSession {
  return botDesktopSession(botId, "local-vm");
}

/** argv that starts or revives one bot's desktop inside the shared Local VM.
 *
 * Idempotent by construction: it exits 0 the moment `cua-driver status` answers
 * on that bot's socket, so repeated turns never spawn a second driver.
 *
 * Built on `cuaExecArgs` so the container, user and `DISPLAY` come from the
 * same seam every other Local VM exec uses, and so the argv works on whichever
 * runtime the host has — `podman` on the macOS Local VM as well as `docker`.
 * Only the trailing command differs from `cuaExecArgs`: the ensure runs a
 * shell script, not the driver binary. */
export function ensureLocalVmSessionExecArgs(
  containerName: string,
  session: LocalVmSharedBotSession,
): string[] {
  const script = [
    "set -eu",
    `display=${session.display}`,
    `socket=${session.socket}`,
    `if ${CUA_EXECUTABLE} status --socket "$socket" >/dev/null 2>&1; then exit 0; fi`,
    // The shared container's own :1 desktop is left alone: this only ever
    // starts the per-bot display when nothing is already answering there.
    `if ! DISPLAY="$display" xset q >/dev/null 2>&1; then`,
    `  if command -v Xvfb >/dev/null 2>&1; then`,
    `    Xvfb "$display" -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &`,
    `  elif command -v Xtigervnc >/dev/null 2>&1; then`,
    `    Xtigervnc "$display" -geometry 1280x720 -depth 24 -SecurityTypes None -rfbport -1 -nolisten tcp >/dev/null 2>&1 &`,
    `  else`,
    `    echo "No X server binary found (neither Xvfb nor Xtigervnc)" >&2`,
    `    exit 1`,
    `  fi`,
    `  attempt=0`,
    `  until DISPLAY="$display" xset q >/dev/null 2>&1; do`,
    `    attempt=$((attempt + 1))`,
    `    if [ "$attempt" -ge 30 ]; then echo "X display $display did not become ready" >&2; exit 1; fi`,
    `    sleep 1`,
    `  done`,
    `fi`,
    `rm -f "$socket"`,
    `nohup env HOME=/home/cua USER=cua DISPLAY="$display" CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CUA_EXECUTABLE} serve --socket "$socket" --permission-mode standard >/tmp/cua-driver-${session.session}.log 2>&1 &`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do`,
    `  ${CUA_EXECUTABLE} status --socket "$socket" >/dev/null 2>&1 && exit 0`,
    `  sleep 0.25`,
    `done`,
    `echo "Cua Driver did not answer on $socket" >&2`,
    `exit 1`,
  ].join("\n");
  return cuaExecArgs(["-ec", script], {
    container: containerName,
    display: session.display,
    command: "sh",
  });
}

/** Start (or confirm) one bot's own desktop inside a shared Local VM container.
 *
 * The container's supervisor owns the `:1` desktop for the human noVNC preview
 * and is left untouched; this brings up the extra Xvfb display and Cua socket
 * that one bot's MCP bridge talks to.  Safe to call on every turn (the argv
 * exits 0 as soon as that socket answers) and safe to call for two bots at once,
 * because each writes only its own display and socket.
 *
 * Lives here rather than in `container-computer.ts` so the import graph stays
 * one-way: index → local-vm-shared-session → container-computer. */
export async function ensureContainerComputerSession(
  runtime: string,
  containerName: string,
  botId: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  await runner(runtime, ensureLocalVmSessionExecArgs(containerName, localVmSharedBotSession(botId)), 60_000);
}
