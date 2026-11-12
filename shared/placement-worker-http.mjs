// This credential class never falls through to a loopback owner's authority.
// Dependency-free so the standalone owner gate and the harness share policy.
export const WORKER_INTENTS = Object.freeze(['register', 'heartbeat', 'assignment', 'payload', 'report', 'stop-receipt']);
const prefix = '/api/placement/worker/';
const credentialPattern = /^BotFleet-Worker bfw1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

export function classifyWorkerRequest(req) {
  const entries = req.rawHeaders?.length
    ? Array.from({ length: req.rawHeaders.length / 2 }, (_, i) => [req.rawHeaders[i * 2].toLowerCase(), req.rawHeaders[i * 2 + 1]])
    : Object.entries(req.headers ?? {}).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter((item) => item !== undefined).map((item) => [name.toLowerCase(), String(item)]));
  const url = req.url ?? '/';
  const authorization = entries.filter(([name]) => name === 'authorization');
  const claimed = url.startsWith(prefix) || /BotFleet-Worker|bfw1\./i.test(url) || entries.some(([name, value]) =>
    name.startsWith('x-botfleet-worker') || /BotFleet-Worker|bfw1\./i.test(value));
  if (!claimed) return { kind: 'none' };
  const deny = () => ({ kind: 'denied' });
  if (req.method !== 'POST' || !WORKER_INTENTS.some((intent) => url === prefix + intent)) return deny();
  if (authorization.length !== 1) return deny();
  const credential = credentialPattern.exec(authorization[0][1]);
  if (!credential) return deny();
  const counts = new Map();
  for (const [name, value] of entries) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === 'cookie' || name === 'origin' || name === 'referer' || name === 'forwarded' || name === 'cdn-loop' ||
        name === 'proxy-authorization' || name === 'upgrade' || name.startsWith('sec-') || name.startsWith('tailscale-') ||
        name.startsWith('x-forwarded-') || name.startsWith('cf-') || name.startsWith('x-botfleet-') ||
        name === 'x-host-id' || name === 'x-worker-host') return deny();
    // Otherwise a hop-by-hop token could strip the credential before proxying.
    if (name === 'connection' && value.split(',').some((part) => !['close', 'keep-alive'].includes(part.trim().toLowerCase()))) return deny();
  }
  if ([...counts.values()].some((count) => count !== 1)) return deny();
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(entries.find(([name]) => name === 'content-type')?.[1] ?? '')) return deny();
  return { kind: 'worker', intent: url.slice(prefix.length), credentialId: credential[1], secret: credential[2] };
}
