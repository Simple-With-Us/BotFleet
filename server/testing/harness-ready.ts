// "The harness is up" is now two questions, not one.
//
// The harness binds its port BEFORE the boot work — the Infisical preload,
// the provider registry load, the post-update resume — so that health answers
// instead of connection-resetting through every boot (audit HS19).  From the
// instant the socket is bound, `/api/health` answers 200 with
// `{ ready: false, booting: true }`, and every other `/api/*` route answers
// 503 `{ error: "booting" }` until the fleet exists.
//
// A suite that waits for `res.ok` therefore stops waiting too early, and its
// first real request lands in the booting window.  Waiting for `ready` is the
// question those loops were always asking.
export async function harnessReady(base: string, timeoutMs?: number): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, {
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) return false;
    // An older harness has no `ready` field at all, and its health answering
    // at all meant ready — so absent counts as ready, never as booting.
    return ((await res.json()) as { ready?: boolean } | null)?.ready !== false;
  } catch {
    return false;
  }
}
