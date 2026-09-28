#!/usr/bin/env node
// The sidecar, as one command.
//
//   node companion/src/index.ts
//
// Three public/runtime sockets, and one optional private managed origin. The
// split between them is the whole security model:
//
//   :8810  loopback  devices     token required, allowlisted, scrubbed
//   :8811  127.0.0.1  you         pairing and revocation — never off-machine
//   :8799  127.0.0.1  the harness spoken to as this machine, unmodified
//   UDS/pipe            one Electron-owned sidecar generation, never TCP
//
// 8810 rather than 8800, which is where these started: the harness opens a
// webhook receiver one port above its own, so 8800 is already taken by the
// app this is a sidecar to. Ten clear of the harness leaves it room to add
// another adjacent listener without taking this one out again.
//
// :8810 is plain HTTP, which is the whole reason it binds loopback and not
// 0.0.0.0.  A device port on the LAN hands every paired phone's bearer token
// and every transcript frame to whoever is on the same wifi, and the
// allowlist on the far side of that socket cannot help: it runs after the
// first bytes are already on the wire.  A phone reaches a paired computer over
// the hosted HTTPS route instead, whose connector lands on this very port.
// Set OMB_COMPANION_ALLOW_CLEARTEXT_LAN=1 to reopen the port on a network
// you control — see `lan-policy.ts` for the threat model and the honest
// default.
//
// Running this process *is* the opt-in for the control plane: there is no
// toggle for that surface, because a toggle inside a process you chose to
// start would be ceremony.  Stopping the process is the off switch, and it is
// a more honest one than a flag in a file.
import { createServer } from "node:http";

import { createAddressWatcher } from "./advertise-watch.ts";
import { createControlServer, hostCandidates } from "./control.ts";
import { createConnectedDeviceTracker } from "./connected-devices.ts";
import { DeviceRegistry } from "./devices.ts";
import { companionEndpointCandidates, hostedCompanionUrl } from "./endpoints.ts";
import {
  advertisesOnLan,
  lanPolicyAdvice,
  lanPolicySummary,
  readLanPolicy,
} from "./lan-policy.ts";
import { lanAddresses, refreshTailnetName, tailnetName, tailscaleAddress } from "./listener.ts";
import {
  advertisableAddresses,
  clampBytes,
  defaultHostName,
  dnsLabel,
  LEGACY_SERVICE_TYPES,
  MdnsResponder,
  SERVICE_TYPE,
  type ServiceInfo,
} from "./mdns.ts";
import { createProxyHandler } from "./proxy.ts";
import { diskKeyFaultStore, watchHarnessNotifications } from "./apns.ts";
import { companionOriginSocket, listenCompanionOrigin } from "./origin.ts";

/** A port from the environment, or the default. Anything that is not a whole
 * number in range is the default — a typo'd port must not become port 0. */
const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  if (value !== undefined && value !== "") {
    console.warn(`companion: ignoring invalid port ${JSON.stringify(value)}; using ${fallback}`);
  }
  return fallback;
};

const HARNESS_PORT = num(process.env.OMB_PORT, 8799);
const WEBHOOK_PORT = num(process.env.OMB_WEBHOOK_PORT, HARNESS_PORT + 1);
const COMPANION_PORT = num(process.env.OMB_COMPANION_PORT, 8810);
const CONTROL_PORT = num(process.env.OMB_CONTROL_PORT, 8811);
let hostedUrl = hostedCompanionUrl(process.env.OMB_COMPANION_HOSTED_URL);
const PRIVATE_ORIGIN = companionOriginSocket(process.env.OMB_COMPANION_INTERNAL_ORIGIN);

/** Whether the device port may leave this machine at all, and in what form.
 *
 * The default is loopback, and that is the whole of S11: `:8810` is plain
 * HTTP, so anything it serves crosses the network in the clear — the pairing
 * credential on the way in, the device's bearer token and every transcript
 * frame on the way out.  The device allowlist and the token check on the far
 * side of that socket are real, and they do not help: they run after the
 * conversation is already on the wire.  See `lan-policy.ts` for the threat
 * model and for why a pinned self-signed certificate needs an iOS change
 * before it can be the default. */
const lanPolicy = readLanPolicy();

/** Ports the harness takes for itself, and what it uses each for.
 *
 * Checked up front rather than left to EADDRINUSE, because the collision is
 * a race and the loser is whoever started second: bind first and the harness
 * reports its webhook receiver unavailable instead, which surfaces nowhere
 * near here. "Port 8800 is the webhook receiver" is a sentence someone can
 * act on; "address already in use" sends them to `lsof`. */
const HARNESS_PORTS = new Map([
  [HARNESS_PORT, "the harness itself"],
  [WEBHOOK_PORT, "the harness's webhook receiver"],
]);

/** A sentence naming what already owns this port, or null when nothing does. */
const conflict = (name: string, port: number): string | null => {
  const owner = HARNESS_PORTS.get(port);
  return owner ? `${name} is set to port ${port}, which is ${owner}` : null;
};

/** What the phone sees this computer called.
 *
 * Asked of the harness rather than invented here: it already knows whose
 * computer this is, from the profile collected during onboarding, and the
 * built-in companion used exactly this. A phone that paired before the move
 * should not suddenly find a differently-named computer in its list.
 *
 * Read once at startup and cached. An override wins, and a harness that is
 * not up or has no profile falls back rather than blocking — the name is a
 * label, and no part of pairing depends on it. */
let cachedName = process.env.OMB_COMPANION_NAME?.trim() || "";

/** What this computer is called on the phone. Never empty. */
const machineName = (): string => cachedName || "BotFleet";

/** Ask the harness whose computer this is, once, at startup. Every failure
 * is survivable: the name is a label, and no part of pairing depends on it. */
async function refreshMachineName(): Promise<void> {
  if (cachedName) return; // an explicit override is not ours to second-guess
  try {
    const res = await fetch(`http://127.0.0.1:${HARNESS_PORT}/api/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const config = (await res.json()) as { profile?: { name?: string } };
    const owner = config.profile?.name?.trim();
    if (owner) cachedName = `${owner}'s computer`;
  } catch {
    /* not up, or no profile — "BotFleet" is a fine thing to be called */
  }
}

const devices = new DeviceRegistry();
const mdns = new MdnsResponder();

/** Keeps the Bonjour record matching the interface table: advertise when a
 * network appears, re-advertise when DHCP moves us, withdraw when it goes —
 * so `mdns.advertising` stays a true statement rather than a boot-time one. */
const watcher = createAddressWatcher({
  addresses: advertisableAddresses,
  // service() reads the current addresses, so a re-advertise carries them
  advertise: () => mdns.advertise(service()),
  withdraw: () => mdns.stop(),
  log: (line) => console.log(`bonjour: ${line}`),
});

/** This machine as a Bonjour record: one DNS label, the device port, and the
 * addresses a phone could reach it on. */
const service = (): ServiceInfo => ({
  // one DNS label: no dots, and inside the 63-byte limit
  name: dnsLabel(machineName()),
  type: SERVICE_TYPE,
  legacyTypes: [...LEGACY_SERVICE_TYPES],
  port: COMPANION_PORT,
  host: defaultHostName(),
  addresses: advertisableAddresses(),
  // TXT entries cap at 255 bytes, and this one is user-supplied — measured in
  // bytes, since that is the unit the wire format actually counts in, and
  // `slice` counts UTF-16 code units.
  txt: ["v=1", `name=${clampBytes(machineName(), 200)}`],
});

const connectedDevices = createConnectedDeviceTracker();
// Started before the proxy so both servers can report the sender's health:
// the pairing page shows it to whoever is at the computer, and the phone
// reads it to explain why a closed-app notification never arrived.
const pushWatch = watchHarnessNotifications({
  harnessPort: HARNESS_PORT,
  connectedIds: connectedDevices.ids,
  tokensForDisconnected: () => devices.pushTokens(),
  forgetToken: (id, token) => {
    devices.clearPushToken(id, token);
  },
  // A key Apple has refused stays refused across relaunches.  Without this
  // the sidecar came back up sending at full rate against a .p8 that had
  // been rejected days earlier, once every forty seconds, while every
  // surface reported pushes as on.
  keyFaultStore: diskKeyFaultStore(),
});
const proxy = createProxyHandler({
    harnessPort: HARNESS_PORT,
    // `authenticate` also stamps lastSeenAt, which is what makes the control
    // page able to say when a phone was last heard from.
    authenticate: (token) => devices.authenticate(token),
    redeem: (code, deviceName, pairRequestId) => devices.redeem(code, deviceName, pairRequestId),
    serverName: machineName,
    // Recomputed per pairing rather than cached: addresses change when the
    // machine joins another network, and a pairing is exactly the moment the
    // list has to be right.
    hosts: () => hostCandidates(undefined, undefined, lanPolicy),
    endpoints: () => companionEndpointCandidates(COMPANION_PORT, undefined, undefined, hostedUrl, undefined, lanPolicy),
    connected: connectedDevices.open,
    setPushToken: (id, token) => devices.setPushToken(id, token),
    pushHealth: pushWatch.health,
  });
const companion = createServer(proxy);
const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null;

const control = createControlServer({
  devices,
  companionPort: COMPANION_PORT,
  hostedUrl: () => hostedUrl,
  setHostedUrl: (next) => {
    hostedUrl = next;
  },
  discovery: () => ({ advertising: mdns.advertising, name: service().name }),
  connectedDeviceIds: connectedDevices.ids,
  disconnectDevice: connectedDevices.disconnect,
  pushHealth: pushWatch.health,
  lanPolicy,
});

/** Bind a server, turning a bind failure into a sentence rather than a stack
 * trace, and leaving a handler behind for the errors that come after. */
const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      // A second copy of the sidecar is the usual cause once the harness's
      // own ports are ruled out above, and "close whatever is using it"
      // sends someone hunting through `lsof` for a process they started.
      const hint = ` — another copy of the companion may already be running; ${
        port === COMPANION_PORT ? "OMB_COMPANION_PORT" : "OMB_CONTROL_PORT"
      } chooses a different one`;
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use${hint}`)
          : error,
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // Bound is not safe, and removing the startup handler while leaving
      // nothing in its place is how a running sidecar dies later. A listening
      // socket still emits `error` — EMFILE on accept, or an interface
      // disappearing under it — and an `error` with no listener is re-thrown
      // as an uncaught exception, which here means the sidecar dies and every
      // paired phone loses the machine over one refused connection. It is
      // worth a line on stderr and nothing more: the other listener, and
      // every connection on this one, carry on.
      server.on("error", (error: NodeJS.ErrnoException) => {
        console.warn(`companion: error on ${host}:${port} — ${error.message}`);
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

/** Start the three-socket arrangement, in the order that makes a failure
 * legible: refuse impossible ports, bind, learn this machine's name, then
 * advertise and print where to point the phone. */
async function main(): Promise<void> {
  const clash =
    conflict("OMB_COMPANION_PORT", COMPANION_PORT) ?? conflict("OMB_CONTROL_PORT", CONTROL_PORT);
  if (clash) throw new Error(`${clash}. Pick another port.`);

  // The sidecar's own two ports, for the same reason as the harness's: bound
  // in order, the second one loses with a bare EADDRINUSE that reads as
  // "something else is using it" when the something else is this process.
  // Worth naming even though the hosts differ — 127.0.0.1 and 0.0.0.0 on one
  // port collide, and if they somehow did not the control plane would be
  // sharing a socket with the device port, which is the one thing the three
  // sockets exist to prevent.
  if (COMPANION_PORT === CONTROL_PORT) {
    throw new Error(
      `OMB_COMPANION_PORT and OMB_CONTROL_PORT are both port ${COMPANION_PORT}, and they cannot share one: ` +
        `the first is open to your network and the second must never be. Pick another port.`,
    );
  }

  await listen(control, CONTROL_PORT, "127.0.0.1");
  await listen(companion, COMPANION_PORT, lanPolicy.deviceBindHost);
  if (managedOrigin && PRIVATE_ORIGIN) {
    await listenCompanionOrigin(managedOrigin, PRIVATE_ORIGIN);
  }

  // Before advertising: the service name goes into the Bonjour record, and
  // re-advertising under a new name later would show the phone two computers.
  await refreshMachineName();

  // Asking Tailscale costs a subprocess, so it happens once, here, rather
  // than per request. Silent on every failure: not installed, not logged in,
  // not running all just mean "no name", and the address still works.
  const tailscaleTried: string[] = [];
  await refreshTailnetName((cli, outcome) => tailscaleTried.push(`  ${cli} — ${outcome}`)).catch(() => {});

  // Discovery failing is not an error anyone has to fix — port 5353 taken by
  // another responder, multicast off, a guest network that isolates its
  // clients. Pairing by typed address still works, and the control page says
  // so rather than pretending the list will fill in.
  //
  // Through the watcher rather than a single advertise: a laptop opened
  // before wifi associates has no addresses yet, and addresses change under
  // a running sidecar. The first check advertises (or says why not), and the
  // interval re-advertises on every change after that.
  //
  // Skipped entirely when the device port is bound to loopback. Multicast DNS
  // is a LAN protocol with no way to say "only this interface", so a record
  // published here would name a port that answers no connection a phone could
  // make — and discovery that finds a computer and then cannot reach it is
  // worse than a phone that never heard of it.
  if (advertisesOnLan(lanPolicy)) {
    await watcher.check();
    watcher.start();
  }

  const addresses = lanAddresses();
  const tailscale = tailscaleAddress(addresses);
  const reach = tailnetName() ?? tailscale ?? addresses[0];
  console.log(`companion  http://${lanPolicy.deviceBindHost}:${COMPANION_PORT}  →  harness 127.0.0.1:${HARNESS_PORT}`);
  console.log(`pair here  http://127.0.0.1:${CONTROL_PORT}`);
  console.log(lanPolicySummary(lanPolicy, COMPANION_PORT));
  for (const line of lanPolicyAdvice(lanPolicy, hostedUrl)) console.log(`  ${line}`);
  if (hostedUrl) console.log(`on your phone, enter  ${hostedUrl}`);
  else if (lanPolicy.allowCleartextLan && reach) console.log(`on your phone, enter  ${reach}:${COMPANION_PORT}`);
  if (tailscale && !tailnetName()) {
    // Do not tell someone to turn on MagicDNS when they may well have it on
    // already — say what was actually tried, so the difference between "off"
    // and "we could not find the CLI" is visible instead of guessed at.
    console.log("no MagicDNS name found. Tailscale CLI attempts:");
    for (const line of tailscaleTried) console.log(line);
  }
}

/** Withdraw the Bonjour record, drop the sockets, exit. Stopping this process
 * is the off switch, so it has to actually stop. */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n${signal} — stopping`);
  // the watcher first, or a tick could re-advertise the record the next
  // line just withdrew
  watcher.stop();
  // The push sender holds its own SSE stream to the harness and a retry
  // timer; without this, stop means stopped everywhere except here.
  pushWatch.stop();
  await mdns.stop().catch(() => {});
  // close() waits for open connections, and an SSE stream never ends on its
  // own — drop the sockets so "stop" means stopped, now.
  companion.closeAllConnections?.();
  control.closeAllConnections?.();
  managedOrigin?.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((r) => companion.close(() => r())),
    new Promise<void>((r) => control.close(() => r())),
    ...(managedOrigin ? [new Promise<void>((r) => managedOrigin.close(() => r()))] : []),
  ]);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
