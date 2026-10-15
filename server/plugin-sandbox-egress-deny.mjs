// Loaded with --import before the plugin sandbox child starts.  Patches Node's
// networking builtins so plugin code cannot open sockets, including loopback and
// unix domain paths.  Native addons and child processes are already blocked by
// the Node permission model; this closes the outbound-socket gap.
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Stable code the sandbox tests assert on. */
export const PLUGIN_EGRESS_DENIED = "ERR_PLUGIN_EGRESS_DENIED";

function egressError(syscall) {
  const err = new Error("Plugin sandbox network access is denied");
  err.code = PLUGIN_EGRESS_DENIED;
  err.errno = -403;
  err.syscall = syscall;
  return err;
}

function denySocketConnect() {
  return function deniedConnect(...args) {
    const err = egressError("connect");
    const socket = new net.Socket();
    // createConnection's optional callback runs on "connect", not with an
    // error argument.  Emit "error" only so callers using the event path see
    // the denial; never invoke the success callback.
    process.nextTick(() => socket.emit("error", err));
    return socket;
  };
}

const net = require("node:net");
net.connect = denySocketConnect(net.connect);
net.createConnection = denySocketConnect(net.createConnection);

const socketProto = net.Socket.prototype;
const originalSocketConnect = socketProto.connect;
socketProto.connect = function deniedSocketConnect(...args) {
  const err = egressError("connect");
  process.nextTick(() => this.emit("error", err));
  return this;
};
socketProto.__originalConnect = originalSocketConnect;

const tls = require("node:tls");
tls.connect = denySocketConnect(tls.connect);

const dgram = require("node:dgram");
dgram.createSocket = function deniedDatagram() {
  throw egressError("socket");
};

const dns = require("node:dns");
function denyLookup(orig) {
  return function deniedLookup(...args) {
    const cb = args.find((entry) => typeof entry === "function");
    const err = egressError("lookup");
    if (cb) {
      process.nextTick(() => cb(err));
      return;
    }
    throw err;
  };
}
dns.lookup = denyLookup(dns.lookup);
if (dns.promises?.lookup) {
  dns.promises.lookup = async function deniedLookupPromise() {
    throw egressError("lookup");
  };
}

function fakeClientRequest() {
  const req = new EventEmitter();
  req.setHeader = () => req;
  req.write = () => true;
  req.end = () => {
    process.nextTick(() => req.emit("error", egressError("request")));
  };
  req.abort = () => {};
  req.destroy = () => {};
  return req;
}

function denyHttpModule(mod) {
  mod.request = function deniedRequest() {
    return fakeClientRequest();
  };
  mod.get = function deniedGet() {
    const req = fakeClientRequest();
    req.end();
    return req;
  };
}

denyHttpModule(require("node:http"));
denyHttpModule(require("node:https"));

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = async function deniedFetch() {
    throw egressError("fetch");
  };
}
