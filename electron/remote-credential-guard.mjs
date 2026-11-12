// A remote server owns its own secrets.  A key set in this app would land in
// this Mac's encrypted store and never reach the server that uses it, so the
// credential handlers refuse before anything is stored or decrypted — the
// owner is told where the key belongs instead of watching a "configured"
// badge that lies.  Kept out of main.mjs so it can be tested without Electron.
export const REMOTE_CREDENTIAL_ERROR =
  "This app is using a remote BotFleet server.\u00a0 Set keys on that server, not in this app.";

export function refuseCredentialsInRemoteMode(serverMode) {
  if (serverMode !== "remote") return;
  throw new Error(REMOTE_CREDENTIAL_ERROR);
}
