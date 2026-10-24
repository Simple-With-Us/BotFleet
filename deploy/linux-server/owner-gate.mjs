#!/usr/bin/env node
/**
 * BotFleet owner gate.
 *
 * A dependency-free reverse proxy that sits between `tailscale serve` and the
 * BotFleet harness on a self-hosted Linux box.  The harness itself binds
 * 127.0.0.1 and treats every loopback caller as the owner, so nothing may
 * forward an unauthenticated remote caller to it.  This gate is that seam.
 *
 * `tailscale serve` terminates TLS inside the tailnet, connects to this
 * listener over loopback, and adds a `Tailscale-User-Login` header.  The gate
 * accepts the request only when that login is on the owner allowlist, the
 * browser Origin is the single allowed public origin, and the request is not
 * cross-site.  Everything else is refused with 403 before the harness is
 * contacted.
 *
 * A tagged Tailscale device gets no `Tailscale-User-Login` header at all:
 * `tailscale serve` only adds it for devices owned by a user.  A desktop app
 * on such a device (a `tag:prod` Mac) therefore presents a second owner
 * credential instead — a shared token in the `x-botfleet-gate-token` header.
 * The gate stores only the sha256 of that token, so a leaked gate.env does
 * not hand over the token itself.  Either credential opens the gate; the
 * token header is dropped before the request reaches the harness.
 *
 * The gate also rewrites the upstream request head: the Host becomes the
 * loopback harness address, and every identity, edge, forwarding and
 * hop-by-hop header is dropped so the harness only ever sees a plain loopback
 * caller.
 *
 * Configuration comes from the environment:
 *
 *   BOTFLEET_GATE_HOST           bind address, default 127.0.0.1 (loopback only)
 *   BOTFLEET_GATE_PORT           bind port, default 8798
 *   BOTFLEET_HARNESS_PORT        harness port, default 8799
 *   BOTFLEET_OWNER_LOGINS        comma-separated Tailscale logins, optional
 *   BOTFLEET_GATE_TOKEN_SHA256   sha256 of the desktop gate token, optional
 *   BOTFLEET_PUBLIC_ORIGIN       the only browser Origin accepted, optional
 *
 * At least one of BOTFLEET_OWNER_LOGINS and BOTFLEET_GATE_TOKEN_SHA256 must be
 * set; the gate refuses to start without an owner credential.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const DEFAULT_GATE_HOST = '127.0.0.1';
const DEFAULT_GATE_PORT = 8798;
const DEFAULT_HARNESS_PORT = 8799;
const HEALTH_PATH = '/__gate/health';
const GATE_NAME = 'botfleet-owner-gate';

/** RFC 7230 hop-by-hop headers.  These never cross the gate. */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Read a header from a plain object regardless of how the caller cased the
 * name.  Node lowercases incoming header names, but the exported helpers are
 * also called with hand-built objects, so the lookup is case-insensitive.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {string} name
 * @returns {string|undefined}
 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
    if (value === undefined || value === null) return undefined;
    return String(value);
  }
  return undefined;
}

/**
 * True when the address is a loopback address.  IPv4-mapped IPv6 loopback
 * (`::ffff:127.0.0.1`) counts, because Node reports it that way when a
 * dual-stack socket accepts an IPv4 client.
 *
 * @param {string|undefined|null} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  let value = String(address).trim().toLowerCase();
  if (!value) return false;
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

/**
 * Parse the owner allowlist.  Logins are lowercased and trimmed because
 * Tailscale reports them in mixed case depending on the identity provider.
 *
 * @param {string|undefined|null} value
 * @returns {Set<string>}
 */
export function parseOwnerLogins(value) {
  const owners = new Set();
  for (const part of String(value ?? '').split(',')) {
    const login = part.trim().toLowerCase();
    if (login) owners.add(login);
  }
  return owners;
}

/**
 * The owner login presented by `tailscale serve`, lowercased.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {string}
 */
export function presentedLogin(headers) {
  return (headerValue(headers, 'tailscale-user-login') ?? '').trim().toLowerCase();
}

/**
 * Parse and validate the desktop gate token's sha256.
 *
 * The gate never stores the token itself, only its digest, so a leaked
 * gate.env cannot be replayed as a credential.  The digest is 64 lowercase
 * hex characters — the sha256 of the token — and anything else is a
 * configuration error rather than a silently ignored value: a mistyped hash
 * would lock the owner out of a server that looks configured but is not.
 *
 * @param {string|undefined|null} value
 * @returns {{ok: true, sha256: string|null} | {ok: false, error: string}}
 */
export function parseTokenSha256(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, sha256: null };
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    return {
      ok: false,
      error:
        'BOTFLEET_GATE_TOKEN_SHA256 must be 64 lowercase hex characters ' +
        '(the sha256 of the desktop gate token)',
    };
  }
  return { ok: true, sha256: raw };
}

/**
 * Does the request carry the desktop gate token?
 *
 * The presented token is hashed and compared against the configured digest
 * with `timingSafeEqual`, so the comparison leaks neither the token nor how
 * much of it matched.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {string|null|undefined} tokenSha256
 * @returns {boolean}
 */
export function tokenMatches(headers, tokenSha256) {
  if (!tokenSha256) return false;
  const presented = headerValue(headers, 'x-botfleet-gate-token');
  if (!presented) return false;
  const digest = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const expected = Buffer.from(tokenSha256, 'hex');
  if (expected.length !== digest.length) return false;
  return crypto.timingSafeEqual(digest, expected);
}

/**
 * Decide whether a request may reach the harness.
 *
 * The rules run in a fixed order: the caller must be loopback, then it must
 * present an owner credential, then the browser Origin must match the single
 * allowed public origin, then the request must not be cross-site.
 *
 * An owner credential is EITHER a login on the allowlist (a user-owned
 * device, where `tailscale serve` adds `Tailscale-User-Login`) OR the
 * desktop gate token (a tagged device, where that header is never added).
 *
 * @param {{remoteAddress?: string, headers?: Record<string, string|string[]|undefined>, owners?: Set<string>|string, publicOrigin?: string, tokenSha256?: string|null}} input
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 */
export function gateDecision({ remoteAddress, headers, owners, publicOrigin, tokenSha256 } = {}) {
  if (!isLoopbackAddress(remoteAddress)) {
    return { ok: false, status: 403, reason: 'gate accepts loopback callers only' };
  }

  const allowlist = owners instanceof Set ? owners : parseOwnerLogins(owners);
  const login = presentedLogin(headers);
  const ownerByLogin = Boolean(login) && allowlist.has(login);
  const ownerByToken = tokenMatches(headers, tokenSha256);
  if (!ownerByLogin && !ownerByToken) {
    return { ok: false, status: 403, reason: 'owner identity required' };
  }

  const originHeader = headerValue(headers, 'origin');
  if (originHeader !== undefined) {
    const allowed = typeof publicOrigin === 'string' ? publicOrigin.trim() : '';
    if (!allowed || originHeader.trim() !== allowed) {
      return { ok: false, status: 403, reason: 'origin not allowed' };
    }
  }

  const fetchSite = (headerValue(headers, 'sec-fetch-site') ?? '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    return { ok: false, status: 403, reason: 'cross-site request blocked' };
  }

  return { ok: true };
}

/**
 * Build the header set sent upstream.  The Host becomes the loopback harness
 * address and every identity, edge, forwarding and hop-by-hop header is
 * dropped, so the harness sees a plain loopback caller and nothing else.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @param {number|string} harnessPort
 * @param {{websocket?: boolean}} [options]
 * @returns {Record<string, string|string[]>}
 */
export function upstreamHeaders(headers, harnessPort, options = {}) {
  const websocket = Boolean(options.websocket);
  const out = {};
  if (!headers || typeof headers !== 'object') {
    out.host = `127.0.0.1:${harnessPort}`;
    return out;
  }

  const connectionTokens = new Set();
  const connection = headerValue(headers, 'connection');
  if (connection) {
    for (const token of connection.split(',')) {
      const name = token.trim().toLowerCase();
      if (name) connectionTokens.add(name);
    }
  }

  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (name === 'host') continue;
    if (rawValue === undefined || rawValue === null) continue;

    if (HOP_BY_HOP_HEADERS.has(name)) {
      if (websocket && (name === 'connection' || name === 'upgrade')) out[name] = rawValue;
      continue;
    }
    if (connectionTokens.has(name)) continue;
    if (name === 'origin' || name === 'referer') continue;
    if (name.startsWith('sec-fetch-')) continue;
    if (name.startsWith('tailscale-')) continue;
    if (name.startsWith('x-forwarded-')) continue;
    if (name.startsWith('cf-')) continue;
    if (name === 'cdn-loop') continue;
    if (name === 'forwarded') continue;
    // The desktop gate token is a credential for THIS gate only: the harness
    // sees a plain loopback caller, so the token never crosses it.  The
    // harness's own `authorization` header is left alone — it carries the
    // harness's bearer tokens, which it needs.
    if (name === 'x-botfleet-gate-token') continue;

    out[name] = rawValue;
  }

  out.host = `127.0.0.1:${harnessPort}`;
  return out;
}

/**
 * Build the response header set sent to the client.  The body is passed
 * through byte for byte, so the upstream framing headers are dropped and Node
 * frames the response itself.
 *
 * @param {Record<string, string|string[]|undefined>|undefined} headers
 * @returns {Record<string, string|string[]>}
 */
export function downstreamHeaders(headers) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = rawName.toLowerCase();
    if (rawValue === undefined || rawValue === null) continue;
    if (name === 'transfer-encoding') continue;
    if (name === 'connection' || name === 'keep-alive' || name === 'proxy-connection') continue;
    if (name === 'trailer') continue;
    out[name] = rawValue;
  }
  return out;
}

/**
 * Parse the path out of a request URL.
 *
 * @param {string|undefined} url
 * @returns {string}
 */
function pathOf(url) {
  const raw = String(url ?? '');
  const query = raw.indexOf('?');
  const path = query === -1 ? raw : raw.slice(0, query);
  return path || '/';
}

/**
 * Write a JSON response.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function respondJson(res, status, payload) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * The default logger.  Every line is timestamped in ISO 8601.
 *
 * @param {string} message
 */
export function defaultLog(message) {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

/**
 * Proxy one plain HTTP request to the harness, streaming both directions
 * without buffering so server-sent events flow as they are produced.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} harnessHost
 * @param {number} harnessPort
 * @param {import('node:http').Agent} agent
 * @param {(message: string) => void} log
 */
function proxyRequest(req, res, harnessHost, harnessPort, agent, log) {
  const upstream = http.request(
    {
      host: harnessHost,
      port: harnessPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req.headers, harnessPort),
      agent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, downstreamHeaders(upstreamRes.headers));
      upstreamRes.on('error', () => res.destroy());
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    log(`[owner-gate] harness unreachable on ${harnessHost}:${harnessPort}: ${err.code ?? err.message}`);
    respondJson(res, 502, { error: 'harness unavailable' });
  });

  //  When the client goes away, tear down the upstream request with it.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.on('error', () => upstream.destroy());

  req.pipe(upstream);
}

/**
 * Write the rewritten request head for an upgraded connection.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} harnessPort
 * @returns {string}
 */
function upgradeHead(req, harnessPort) {
  const headers = upstreamHeaders(req.headers, harnessPort, { websocket: true });
  headers.connection = 'Upgrade';
  headers.upgrade = headers.upgrade ?? 'websocket';
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/**
 * Create the gate server.  The returned server is not listening yet.
 *
 * @param {{owners?: Set<string>|string, publicOrigin?: string, tokenSha256?: string|null, harnessPort?: number|string, harnessHost?: string, log?: (message: string) => void}} options
 * @returns {import('node:http').Server}
 */
export function createOwnerGate({
  owners,
  publicOrigin,
  tokenSha256,
  harnessPort = DEFAULT_HARNESS_PORT,
  harnessHost = DEFAULT_GATE_HOST,
  log,
} = {}) {
  const allowlist = owners instanceof Set ? owners : parseOwnerLogins(owners);
  const logger = typeof log === 'function' ? log : defaultLog;
  const port = Number(harnessPort) || DEFAULT_HARNESS_PORT;
  const origin = typeof publicOrigin === 'string' ? publicOrigin.trim() : '';
  const tokenDigest = typeof tokenSha256 === 'string' ? tokenSha256.trim() : '';

  //  A dedicated agent with keep-alive off, so no pooled socket outlives the
  //  request that opened it.
  const upstreamAgent = new http.Agent({ keepAlive: false });

  const server = http.createServer((req, res) => {
    const decision = gateDecision({
      remoteAddress: req.socket?.remoteAddress,
      headers: req.headers,
      owners: allowlist,
      publicOrigin: origin,
      tokenSha256: tokenDigest,
    });

    if (!decision.ok) {
      const login = presentedLogin(req.headers);
      logger(
        `[owner-gate] refused ${req.method} ${pathOf(req.url)}: ${decision.reason}` +
          (login ? ` (login=${login})` : ''),
      );
      respondJson(res, decision.status, { error: decision.reason });
      return;
    }

    if (pathOf(req.url) === HEALTH_PATH) {
      respondJson(res, 200, { ok: true, gate: GATE_NAME });
      return;
    }

    proxyRequest(req, res, harnessHost, port, upstreamAgent, logger);
  });

  //  A long server-sent event stream must never be cut short by a timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 65_000;

  server.on('upgrade', (req, socket, head) => {
    const decision = gateDecision({
      remoteAddress: socket.remoteAddress,
      headers: req.headers,
      owners: allowlist,
      publicOrigin: origin,
      tokenSha256: tokenDigest,
    });

    if (!decision.ok) {
      const login = presentedLogin(req.headers);
      logger(
        `[owner-gate] refused upgrade ${pathOf(req.url)}: ${decision.reason}` +
          (login ? ` (login=${login})` : ''),
      );
      const body = Buffer.from(JSON.stringify({ error: decision.reason }));
      socket.write(
        'HTTP/1.1 403 Forbidden\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${body.length}\r\n` +
          'Connection: close\r\n' +
          '\r\n',
      );
      socket.write(body);
      socket.destroy();
      return;
    }

    const upstream = net.connect(port, harnessHost, () => {
      upstream.write(upgradeHead(req, port));
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    //  Both halves of the tunnel close together, so no socket outlives the
    //  request that opened it.
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    //  A client that hangs up cleanly sends a FIN and stops writing, but its
    //  socket stays half-open, so 'close' never fires and the tunnel would
    //  outlive the request that opened it.  The half-close ends it here.
    socket.on('end', () => upstream.destroy());
    upstream.on('end', () => socket.destroy());
  });

  return server;
}

/**
 * Read the environment, refuse an unsafe configuration, and listen.
 */
function main() {
  const gateHost = (process.env.BOTFLEET_GATE_HOST || DEFAULT_GATE_HOST).trim();
  const gatePort = Number(process.env.BOTFLEET_GATE_PORT || DEFAULT_GATE_PORT);
  const harnessPort = Number(process.env.BOTFLEET_HARNESS_PORT || DEFAULT_HARNESS_PORT);
  const owners = parseOwnerLogins(process.env.BOTFLEET_OWNER_LOGINS || '');
  const publicOrigin = (process.env.BOTFLEET_PUBLIC_ORIGIN || '').trim();

  if (!isLoopbackAddress(gateHost)) {
    process.stderr.write(
      `${new Date().toISOString()} [owner-gate] refusing to start: ` +
        `BOTFLEET_GATE_HOST=${gateHost} is not a loopback address.\n`,
    );
    process.exit(1);
  }

  //  A malformed token hash is a configuration error, not a missing token:
  //  silently ignoring it would leave a server that looks configured and
  //  refuses every desktop request.  The hash itself is never logged.
  const parsedToken = parseTokenSha256(process.env.BOTFLEET_GATE_TOKEN_SHA256 || '');
  if (!parsedToken.ok) {
    process.stderr.write(
      `${new Date().toISOString()} [owner-gate] refusing to start: ${parsedToken.error}.\n`,
    );
    process.exit(1);
  }
  const tokenSha256 = parsedToken.sha256;

  //  At least one owner credential must exist, or the gate would wave every
  //  request through to the harness.
  if (owners.size === 0 && !tokenSha256) {
    process.stderr.write(
      `${new Date().toISOString()} [owner-gate] refusing to start: ` +
        'no owner credential is configured.  Set BOTFLEET_OWNER_LOGINS to a ' +
        'comma-separated list of Tailscale logins, for example ' +
        'BOTFLEET_OWNER_LOGINS=owner@example.com, or set ' +
        'BOTFLEET_GATE_TOKEN_SHA256 to the sha256 of the desktop gate token.\n',
    );
    process.exit(1);
  }

  const server = createOwnerGate({
    owners,
    publicOrigin,
    tokenSha256,
    harnessPort,
    harnessHost: '127.0.0.1',
  });

  server.on('error', (err) => {
    process.stderr.write(`${new Date().toISOString()} [owner-gate] server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(gatePort, gateHost, () => {
    const address = server.address();
    const boundPort = address && typeof address === 'object' ? address.port : gatePort;
    //  Whether a token is configured is not a secret; the token and its hash
    //  never appear in a log line.
    defaultLog(
      `[owner-gate] listening on ${gateHost}:${boundPort} -> harness 127.0.0.1:${harnessPort} ` +
        `(owners: ${owners.size}, token: ${tokenSha256 ? 'yes' : 'no'})`,
    );
  });
}

const entry = process.argv[1];
if (entry) {
  let isDirectRun = false;
  try {
    isDirectRun = import.meta.url === pathToFileURL(entry).href;
  } catch {
    isDirectRun = false;
  }
  if (isDirectRun) main();
}
