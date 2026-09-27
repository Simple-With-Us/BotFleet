// The main window's trust boundary for anything privileged: the preload
// bridge reaches ~50 ipcMain handlers, and several of those hand back a
// device token, store a credential, or open a terminal.  A page that manages
// to become the window's document inherits all of it, so every one of those
// entry points first has to prove it is the app's own renderer.
//
// Two checks, and both matter.  Navigation decides which page gets to be the
// document in the first place; the sender check decides whether the caller
// still is.  Kept dependency-free and out of main.mjs so it is testable
// without an Electron runtime.

/**
 * Is this URL the app's own renderer?  Compares origins, so every route,
 * query, and hash the SPA uses is the same page as far as trust goes — and a
 * `data:` or `file:` document, which has no origin to match, is not.
 *
 * @param {unknown} rawUrl
 * @param {string | (() => string)} origin the renderer origin, or a getter
 *   for it (the port is not settled until the harness probe finishes)
 */
export function isTrustedRendererUrl(rawUrl, origin) {
  const expected = resolveOrigin(origin);
  if (!expected) return false;
  return parseOrigin(rawUrl) === expected;
}

/** The origin a candidate is judged against, or null when there is not one.
 *
 *  Accepts the getter because the port is not settled when the guard is
 *  installed, and resolves it at call time.  Anything that does not parse as
 *  an absolute URL is refused rather than coerced: `undefined`, a number and
 *  a bare hostname all stringify, and only the last of those was ever meant.
 *
 *  @param {string | (() => string)} origin */
function resolveOrigin(origin) {
  // `instanceof Function`, not `typeof … === "function"`: the parameter's
  // declared type is this two-member union, so the question is which member
  // arrived, and callability is what makes the difference.
  return parseOrigin(origin instanceof Function ? origin() : origin);
}

/** The origin of a URL, or null when the input is not one.  The whole
 *  fail-closed decision is delegated to the URL parser: a `data:` or `file:`
 *  document has an opaque origin that can never equal ours, which is exactly
 *  why refusing to parse is the safe branch and not merely the strict one. */
function parseOrigin(value) {
  try {
    return new URL(String(value ?? "")).origin;
  } catch {
    return null;
  }
}

/** The document that is making this IPC call.  The main frame when there is one. */
function senderFrameUrl(event) {
  const url = event?.senderFrame?.url;
  if (url) return url;
  const sender = event?.sender;
  if (sender?.getURL) {
    const fromWindow = sender.getURL();
    if (fromWindow) return fromWindow;
  }
  return "";
}

/**
 * Throw unless the IPC call came from the app's own renderer.  A foreign or
 * unreadable sender is refused: an unknown caller is not a trusted one.
 *
 * @returns {true} so a handler can call it as a guard
 */
export function assertTrustedSender(event, { origin }) {
  if (!isTrustedRendererUrl(senderFrameUrl(event), origin)) {
    throw new Error("Only the BotFleet app window can do that");
  }
  return true;
}

/**
 * The one choke point: wrap `ipcMain.handle` so every handler — the ones in
 * main.mjs and the ones registered by the CUA, updater, and Android-device
 * modules — validates its sender before running.  Call it before the first
 * registration; wrapping afterwards would leave the earlier handlers open.
 */
export function installTrustedIpcGuard(ipcMain, { origin }) {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      assertTrustedSender(event, { origin });
      return listener(event, ...args);
    });
  return ipcMain;
}
