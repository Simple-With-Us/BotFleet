import { botDesktopDigest, botDesktopDisplayFor, botDesktopSession } from "./bot-desktop-session.ts";
import { CUA_EXECUTABLE, CUA_SOCKET, DISPLAY } from "./container-computer.ts";
import type { AppConfig } from "./config.ts";

/** Per-bot desktop identity inside the one shared VPS container.  Leases,
 * viewer tunnels, and MCP bridges key off the same `occupancyKey` as
 * per-bot mode, while provision/lifecycle still use `SHARED_VPS_TARGET`. */
export interface VpsSharedBotSession {
  readonly occupancyKey: string;
  readonly display: string;
  readonly socket: string;
  readonly session: string;
  readonly screenshotPath: string;
}

export function isSharedVpsMode(cfg: AppConfig): boolean {
  return cfg.botDefaults?.vpsMode === "shared";
}

export function perBotOccupancyKey(botId: string): string {
  return `bot:${botDesktopDigest(botId)}`;
}

/** Lease / tunnel / occupancy key for a bot's VPS turn.  Always per-bot —
 * shared mode reuses one container but not one desktop lease. */
export function vpsOccupancyKey(_cfg: AppConfig, botId: string): string {
  return perBotOccupancyKey(botId);
}

/** Map each bot id to a distinct X display number.  Display numbers must be
 *  bounded (10..50009) so that TCP port 6000 + display does not exceed the
 *  16-bit unsigned port maximum (65535) or fail X server launch, while
 *  remaining collision-resistant across bot ids. */
export function vpsSharedDisplayForBot(botId: string): string {
  return botDesktopDisplayFor(botId);
}

/** Deterministic display + CUA socket for one bot on the shared container. */
export function vpsSharedBotSession(botId: string): VpsSharedBotSession {
  return { occupancyKey: perBotOccupancyKey(botId), ...botDesktopSession(botId, "vps") };
}

export function vpsDriverSocket(cfg: AppConfig, botId: string): string {
  return isSharedVpsMode(cfg) ? vpsSharedBotSession(botId).socket : CUA_SOCKET;
}

export function vpsDriverDisplay(cfg: AppConfig, botId: string): string {
  return isSharedVpsMode(cfg) ? vpsSharedBotSession(botId).display : DISPLAY;
}

export function vpsScreenshotPath(cfg: AppConfig, botId: string): string {
  return isSharedVpsMode(cfg) ? vpsSharedBotSession(botId).screenshotPath : "/tmp/botfleet-vps-preview.png";
}

/** Shared container sleep/remove/stop must not run while any bot holds a VPS
 * turn lease on the one shared host. */
export function sharedVpsContainerLifecycleBlocked(
  cfg: AppConfig,
  _botId: string,
  activeLeaseCount: number,
  selfBusy: boolean,
  selfHasLease: boolean,
): boolean {
  if (selfBusy || selfHasLease) return true;
  return isSharedVpsMode(cfg) && activeLeaseCount > 0;
}

/** argv tail for `docker exec` that starts or revives one bot's isolated
 * desktop stack inside the shared container. */
export function ensureSharedVpsSessionExecArgs(
  containerRef: string,
  session: VpsSharedBotSession,
): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(containerRef) && !/^sha256:[a-f0-9]{64}$/i.test(containerRef)) {
    throw new Error("invalid VPS container reference for session ensure");
  }
  const script = [
    "set -eu",
    `display=${session.display}`,
    `socket=${session.socket}`,
    `if ${CUA_EXECUTABLE} status --socket "$socket" >/dev/null 2>&1; then exit 0; fi`,
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
    `echo "CUA Driver did not answer on $socket" >&2`,
    `exit 1`,
  ].join("\n");
  return [
    "exec",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    containerRef,
    "sh",
    "-ec",
    script,
  ];
}
