# Native Companion Pairing Contract

BF-2591 completes the client contract portion of BF-2511.  The native server now passes the phone's health identity probe, accepts manual-code and QR credentials in one expiring window, recovers a lost pairing reply with a credential-bound request ID, and returns the envelope the existing phone decodes.  Authenticated endpoint discovery reads only metadata injected by the app.

Claude's original commit `eb922253` was adopted with authorship credit in a separate CODEX lane.  Integration preserves the native runtime constructor injection and wait routes added after that commit.

## Compatibility Choices

- Closed or expired pairing windows return 401 so the phone reports an authentication refusal.  Wrong guesses retain 403, the last permitted wrong guess returns 429, and successful pairing retains 200; the client accepts those responses.
- Existing machine error strings and the existing device-token format are preserved.  Human error copy and durable hashed device credentials with revocation remain follow-ups under BF-2511.
- Pairing replay expires at the original window expiry.  Closing or replacing the window removes replay state.
- Endpoint metadata comes from the injected advertisement, never request Host or forwarding headers.  The default advertisement is empty.

## Verification

The new Swift fixtures drive the real CompanionClient through an ephemeral URLProtocol session and an in-memory database.  They open no socket and use an injected clock rather than waiting for expiry.

Run `swift test --package-path ios --filter NativeCompanionPairingContractTests`, then the complete Swift package suite and unsigned iOS build.  Repository checks are `pnpm typecheck`, `pnpm test`, and `git diff --check`; exact execution results are recorded on the PR.

## Delivery Boundary

The listener remains off by default and loopback-only.  This contract change does not establish phone-to-Mac production acceptance or authorize network exposure.  Durable credentials, browser Origin rejection, private-response headers, LAN opt-in, Bonjour, and app-owned advertisement and pairing-window wiring remain BF-2511 acceptance work.  BF-2595 separately tracks post-ready listener failures in Lifecycle Settings.

Native Mac release numbering remains gated by BF-2588.  A merged change is not an installed native build.
