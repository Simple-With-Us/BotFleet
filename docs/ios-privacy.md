# BotFleetMobile privacy

BotFleetMobile is a companion for an BotFleet service chosen and operated
by the user. Local Wi-Fi and Tailscale connections work without an BotFleet
account. A user may separately sign in on the desktop to enable the optional
**Use your phone anywhere** HTTPS connection.  Current desktop builds do not
include a hosted control plane; that option appears only when the desktop is
configured with a BotFleet-operated control plane, and no hosted data is sent
otherwise.

## Data handling

- The iOS app stores the selected computer address in iOS preferences and its
  pairing token in the iOS Keychain.
- The computer remains the source of bots, transcripts, approvals, credentials,
  SQLite data, and screen images. BotFleet's hosted control plane does not
  store a copy of that content.
- On a local Wi-Fi or Tailscale connection, phone traffic goes directly to the
  user's computer. Tailscale is a separate service with its own privacy terms.
- If the desktop user enables optional hosted access, BotFleet stores the
  account email address, an internal account ID, and computer installation
  metadata: an opaque installation ID, opaque client ID, computer display name,
  operating system, app version, status, and security timestamps. It also stores
  opaque Cloudflare Tunnel/DNS resource IDs and redacted operational errors.
  These records are used only for sign-in, ownership, abuse prevention,
  provisioning, revocation, support, and reliability.
- The optional HTTPS route is proxied by Cloudflare to an outbound-only
  `cloudflared` connector on the user's computer. Messages, approvals,
  transcript responses, and screen frames pass through Cloudflare in transit,
  but are not written to the BotFleet control-plane database. Cloudflare may
  process IP addresses and connection/request metadata as BotFleet's service
  provider under Cloudflare's privacy terms.
- Connector tokens stay in the desktop operating system's encrypted credential
  store. Pairing and device tokens are not stored in the hosted control-plane
  database.
- The app contains no advertising or product-analytics SDK, does not track
  users across other companies' apps or websites, and does not sell personal
  data.  This is a statement about BotFleetMobile (the iOS app) only; the
  desktop app is a different product with a different data-handling
  statement — see [Observability](observability.md) for what it bundles and
  how to opt out.
- The app includes the Sentry crash-reporting SDK.  When a build is cut with a
  Sentry DSN, the app sends crash reports, app-hang reports, a sample of
  performance traces, a sample of **session replays**, and failed-request
  diagnostics (HTTP 5xx responses and their URL) to Sentry, together with the
  device model, OS version, app version, and an anonymous installation
  identifier.  These reports never include message content, transcripts, or
  pairing tokens, and query parameters named token, key, secret, auth, or
  password are redacted on the phone before anything is sent.
- **Session replay is on, and it does record the screen.**  The build samples
  about 10% of sessions and about 10% of error sessions
  (`sessionReplay.sessionSampleRate = 0.1`, `onErrorSampleRate = 0.1` in
  `ios/App/SentryTelemetry.swift`).  A replay is a recording of the app's own
  user interface, so it can include the text and layout the user saw.  All
  text is masked (`maskAllText = true`) and all images are blocked
  (`maskAllImages = true`), so values are replaced with blocks before the
  recording leaves the device; what a replay carries is the shape of the
  screen — where elements sit, what is on them, and what happened — not the
  strings behind them.  A masked replay can still show a bot's display name, a
  room's name, and the presence of message text, so it is User Content for
  privacy purposes even though the text itself is unreadable.
- **Profiling is on.**  `profilesSampleRate = 0.1` samples about 10% of
  transactions for continuous profiling, which records call stacks and timing
  for the app's own code.  It carries no message content and no user-entered
  text, and it is used only to find and fix performance defects.
- Two Sentry options are explicitly off: `attachScreenshot = false` and
  `attachViewHierarchy = false`, so a crash report never carries a screenshot
  or a view-hierarchy dump.  `sendDefaultPii = false` keeps headers, cookies,
  and IP-derived user data out.  A request whose status matches a paired
  computer that is simply offline is dropped before it is sent.  Sentry
  processes this data as BotFleet's service provider under Sentry's privacy
  terms and may see the connection's IP address in transit.  Crash,
  performance, and replay data is used only to find and fix defects and is not
  used for tracking.

Local HTTP connections should only be used on a network the user trusts.
Tailscale and hosted HTTPS access are encrypted alternatives for untrusted or
remote networks; neither makes a sleeping or powered-off computer reachable.

## Retention, control, and deletion

Unpairing removes the computer address and pairing token from the phone.
Revoking the phone in BotFleet's Companion settings invalidates that device
credential. Transcript deletion is controlled by the BotFleet installation
that stores the transcript.

Crash and performance reports are kept on Sentry only as long as they are
needed to diagnose a defect, within Sentry's retention limits, and are not
linked to a BotFleet account.

Signing out of optional hosted access stops advertising the hosted address,
revokes the computer installation credential, and schedules deletion of its
Cloudflare Tunnel and DNS record. Account email, account identifiers,
installation/security metadata, and operational records are retained while
needed to operate and protect the service, and otherwise until the account
holder asks for deletion. Some minimal records may be retained when required
for security, fraud prevention, dispute resolution, or law.

To request a copy or deletion of hosted account data, open an
[BotFleet Support](https://github.com/Simple-With-Us/BotFleet/issues) request
without posting an OTP, pairing code, device token, connector token, or other
secret. The maintainer will provide a private way to verify control of the
email address. Deleting hosted account data does not delete transcripts stored
on the user's own computer.

## Support

Privacy questions can be opened at
[BotFleet Support](https://github.com/Simple-With-Us/BotFleet/issues).
