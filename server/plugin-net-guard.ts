// In-process outbound network guard for the plugin sandbox child.
//
// Installed before the plugin module is imported.  Node's permission
// model denies the network only when this Node build understands
// `--allow-net` (Node 25 and later).  On the Node 24 runtime BotFleet
// ships, a plugin can still open sockets, including through
// `process.binding("tcp_wrap")`, which never touches `node:net`.
//
// The guard does three things:
//   * locks `process.binding`, `process._linkedBinding`, and
//     `process.dlopen`, so the plugin cannot reach a raw TCP handle or
//     load a native addon even if the permission model missed one,
//   * replaces `net.Socket.prototype.connect` so TCP connects are
//     allowed only to the sealed host:port list,
//   * denies UDP outright, and denies DNS except `lookup` of a host the
//     allowlist already names.
//
// The allowlist starts empty and is sealed from the parent's load
// message before the plugin is imported.  A later seal is ignored, so
// plugin code cannot widen it by emitting a fake load message.
import dgram from "node:dgram";
import dns, { promises as dnsPromises } from "node:dns";
import net from "node:net";

import { hostIsAllowlisted, networkAllowMatches, normalizePluginNetworkAllow } from "../shared/plugin-net-allow.ts";

const DENIED_CODE = "ERR_ACCESS_DENIED";

interface NativeModule {
  filename: string;
}

interface ProcessBindings {
  binding?: (id: string) => NativeModule;
  _linkedBinding?: (id: string) => NativeModule;
  dlopen?: (module: NativeModule, filename: string) => void;
}

type NodeCallback = (error: NodeJS.ErrnoException) => void;

/** Fields `net.Socket.connect` may carry.  Each one is decoded before use. */
interface ConnectFields {
  host?: Hostile;
  hostname?: Hostile;
  address?: Hostile;
  port?: Hostile;
  path?: Hostile;
}

/** Values a plugin can pass into a patched Node method. */
type Hostile =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Hostile[]
  | ConnectFields
  | NodeCallback;

type ConnectDest =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "denied" };

type ConnectForward = (this: net.Socket, ...args: Hostile[]) => net.Socket;

interface DnsApi {
  lookup?: (this: DnsApi, hostname: string, ...rest: Hostile[]) => void;
  lookupService?: (...args: Hostile[]) => void;
  resolve?: (...args: Hostile[]) => void;
  resolve4?: (...args: Hostile[]) => void;
  resolve6?: (...args: Hostile[]) => void;
  resolveAny?: (...args: Hostile[]) => void;
  resolveCaa?: (...args: Hostile[]) => void;
  resolveCname?: (...args: Hostile[]) => void;
  resolveMx?: (...args: Hostile[]) => void;
  resolveNaptr?: (...args: Hostile[]) => void;
  resolveNs?: (...args: Hostile[]) => void;
  resolvePtr?: (...args: Hostile[]) => void;
  resolveSoa?: (...args: Hostile[]) => void;
  resolveSrv?: (...args: Hostile[]) => void;
  resolveTxt?: (...args: Hostile[]) => void;
  reverse?: (...args: Hostile[]) => void;
  setServers?: (...args: Hostile[]) => void;
  getServers?: (...args: Hostile[]) => void;
  setLocalAddress?: (...args: Hostile[]) => void;
  cancel?: (...args: Hostile[]) => void;
}

const DNS_DENY = [
  "lookupService",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse",
  "setServers",
  "getServers",
  "setLocalAddress",
  "cancel",
] as const;

function denied(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error("network access denied");
  error.code = DENIED_CODE;
  return error;
}

function tagOf(value: Hostile): string {
  return Object.prototype.toString.call(value);
}

function asString(value: Hostile): string | null {
  if (value === undefined || value === null) return null;
  if (tagOf(value) !== "[object String]") return null;
  return String(value);
}

function asPort(value: Hostile): number | null {
  if (tagOf(value) === "[object Number]") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  if (tagOf(value) !== "[object String]") return null;
  const text = String(value);
  if (!/^[0-9]+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return null;
  return parsed;
}

function asList(value: Hostile): readonly Hostile[] | null {
  if (tagOf(value) !== "[object Array]") return null;
  // SAFETY: the `[object Array]` tag means a real array.  Each element is read back as Hostile and decoded again, and describeConnect unwraps only one level.
  return value as readonly Hostile[];
}

function asFields(value: Hostile): ConnectFields | null {
  if (tagOf(value) !== "[object Object]") return null;
  // SAFETY: the `[object Object]` tag means a plain object.  host, hostname, address, port, and path are decoded with asString and asPort before the allowlist sees them.
  return value as ConnectFields;
}

function asCallback(value: Hostile): NodeCallback | null {
  if (!(value instanceof Function)) return null;
  // SAFETY: a same-realm function is the optional Node-style error callback on DNS and dgram.  The guard calls it with the denial and does not perform the operation.
  return value as NodeCallback;
}

type LockTarget = ProcessBindings | DnsApi | net.Socket | dgram.Socket;

function lock(target: LockTarget, name: string, value: Function): void {
  try {
    Object.defineProperty(target, name, {
      value,
      writable: false,
      configurable: false,
    });
  } catch {
    // The property was already non-configurable.  Assignment still
    // replaces a writable one; a frozen builtin is left as Node shipped it.
    try {
      Reflect.set(target, name, value);
    } catch {
      // Nothing else can be done from JavaScript.  The OS wrapper is the
      // backstop for that case.
    }
  }
}

function denyCallbackOrThrow(args: readonly Hostile[]): void {
  const error = denied();
  const last = args[args.length - 1];
  const callback = last === undefined ? null : asCallback(last);
  if (callback) {
    callback(error);
    return;
  }
  throw error;
}

function describeConnect(args: readonly Hostile[], unwrapped = false): ConnectDest {
  const first = args[0];
  if (first === undefined) return { kind: "denied" };
  // net.connect passes Socket.prototype.connect an already-normalized
  // array, `[options, callback]`.  Read the options object inside it.
  // One unwrap only, so a hostile value cannot recurse.
  if (!unwrapped) {
    const list = asList(first);
    if (list) {
      const inner = list[0];
      return describeConnect(inner === undefined ? [] : [inner], true);
    }
  }
  const numericPort = asPort(first);
  if (numericPort !== null && tagOf(first) === "[object Number]") {
    const hostArg = args[1];
    const host = hostArg === undefined ? "localhost" : (asString(hostArg) ?? "localhost");
    return { kind: "tcp", host, port: numericPort };
  }
  if (asString(first) !== null) return { kind: "denied" };
  const fields = asFields(first);
  if (!fields) return { kind: "denied" };
  // Read each property once.  A getter can return a different value on
  // the next access, so a second read must not decide the allowlist.
  const pathValue = fields.path;
  const portValue = fields.port;
  const hostValue = fields.host;
  const hostnameValue = fields.hostname;
  const addressValue = fields.address;
  const path = pathValue === undefined ? null : asString(pathValue);
  if (path !== null && (portValue === undefined || portValue === null)) return { kind: "denied" };
  const port = portValue === undefined || portValue === null ? null : asPort(portValue);
  if (port === null) return { kind: "denied" };
  const host = (hostValue === undefined ? null : asString(hostValue))
    ?? (hostnameValue === undefined ? null : asString(hostnameValue))
    ?? (addressValue === undefined ? null : asString(addressValue))
    ?? "localhost";
  return { kind: "tcp", host, port };
}

function denyDnsMethod(...args: Hostile[]): undefined {
  denyCallbackOrThrow(args);
  return undefined;
}

function patchLookup(target: DnsApi, allow: () => readonly string[]): void {
  const lookup = target.lookup;
  if (!(lookup instanceof Function)) return;
  lock(target, "lookup", function guardedLookup(this: DnsApi, hostname: Hostile, ...rest: Hostile[]): void {
    const host = asString(hostname);
    if (host === null || !hostIsAllowlisted(allow(), host)) {
      denyCallbackOrThrow(rest);
      return;
    }
    return lookup.call(this, host, ...rest);
  });
}

function patchDnsMethods(target: DnsApi): void {
  for (const name of DNS_DENY) {
    if (!(target[name] instanceof Function)) continue;
    lock(target, name, denyDnsMethod);
  }
}

function denyBinding(): never {
  throw denied();
}

/** Install the guard.  Call `seal` once with the parent's allowlist
 *  before importing the plugin.  Further seals do nothing. */
export function installPluginNetworkGuard(): { seal(entries: readonly string[]): void } {
  let allow: readonly string[] = [];
  let sealed = false;
  const current = (): readonly string[] => allow;

  const proc: ProcessBindings = process;
  if (proc.binding instanceof Function) lock(proc, "binding", denyBinding);
  if (proc._linkedBinding instanceof Function) lock(proc, "_linkedBinding", denyBinding);
  if (proc.dlopen instanceof Function) lock(proc, "dlopen", denyBinding);

  // SAFETY: node:dns and dns/promises are the live method tables.  The guard only reads the names it replaces.
  const dnsApi = dns as DnsApi;
  // SAFETY: same method table as node:dns, promisified.  Patched separately so a plugin cannot use either surface.
  const dnsPromiseApi = dnsPromises as DnsApi;
  patchLookup(dnsApi, current);
  patchDnsMethods(dnsApi);
  patchLookup(dnsPromiseApi, current);
  patchDnsMethods(dnsPromiseApi);
  // SAFETY: Resolver.prototype carries the same DNS operations.  patchDnsMethods replaces only the deny-list names.
  patchDnsMethods(dns.Resolver.prototype as DnsApi);
  if (dnsPromises.Resolver instanceof Function) {
    // SAFETY: the promises Resolver prototype is the async twin of dns.Resolver.prototype.
    patchDnsMethods(dnsPromises.Resolver.prototype as DnsApi);
  }

  // SAFETY: Socket.prototype.connect is an overloaded method.  The wrapper forwards a new object whose host and port are the strings describeConnect already read.  The plugin's object is not passed through, so a getter cannot change the destination after the allowlist check.  Unix-socket connects are denied.
  const forward = net.Socket.prototype.connect as ConnectForward;
  lock(net.Socket.prototype, "connect", function guardedConnect(this: net.Socket, ...args: Hostile[]): net.Socket {
    if (!(this instanceof net.Socket)) throw denied();
    const dest = describeConnect(args);
    if (dest.kind !== "tcp" || !networkAllowMatches(current(), dest.host, dest.port)) {
      throw denied();
    }
    const clean = { host: dest.host, port: dest.port };
    const last = args[args.length - 1];
    const callback = last === undefined ? null : asCallback(last);
    if (callback) return forward.call(this, clean, callback);
    return forward.call(this, clean);
  });

  function denyUdp(this: dgram.Socket, ...args: Hostile[]): undefined {
    const error = denied();
    const last = args[args.length - 1];
    const callback = last === undefined ? null : asCallback(last);
    if (callback) {
      callback(error);
      return undefined;
    }
    this.emit("error", error);
    return undefined;
  }
  lock(dgram.Socket.prototype, "send", denyUdp);
  lock(dgram.Socket.prototype, "connect", denyUdp);

  return {
    seal(entries: readonly string[]) {
      if (sealed) return;
      sealed = true;
      allow = normalizePluginNetworkAllow(entries);
    },
  };
}
