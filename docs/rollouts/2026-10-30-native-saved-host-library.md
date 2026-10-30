# Native Saved Hosts And Placement Handshake

Refs BF-2559.  Implements the library portion of Server First slice 5 under BF-2599; it enables no mode picker, background service, remote enrollment or job dispatch.

## Behavior

`HostStore` starts with This Mac alone and keeps host metadata separate from credentials.  Remote origins require HTTPS; HTTP is accepted only for loopback tunnels.  User information, paths, queries, fragments and invalid ports are refused without echoing the supplied value.  An existing remote record cannot change origin or clear or replace its pinned host identity; a new enrollment requires a new record.  Removing This Mac, a selected server, a controller or a leased host is refused.

The store writes an exclusive 0600 temporary file, syncs it, and renames it atomically while holding an owner-checked nonblocking file lock.  Separate store instances reload inside that lock.  Reads use one nonblocking, no-follow descriptor and validate its owner, permissions and regular-file type before decoding.  The immediate parent must belong to this user and be unwritable by others; callers supply an app-owned support directory rather than a shared location.  Malformed regular-file bytes are preserved in an exclusive 0600 backup where possible, and the original file is never overwritten on a failed read.  A locked, unsafe or unreadable store reports an error instead of resetting it.

`KeychainHostTokenStore` uses a separate per-user namespace.  A locked or inaccessible Keychain reports unavailable; it is never treated as an empty credential.  It reads no Control JSON, service credential, fleet handoff or fallback store.  The credential wrapper redacts text conversion and authorizes only its enrolled origin.  Ordinary CompanionClient requests and event streams reject redirects outside that origin when using this optional gate credential; existing clients have no added header or redirect behavior.

The read-only handshake requires BotFleet health/readiness, a valid stable identity, the resources route, matching resource identity/version/capabilities, and a compatible placement identity including controller and epoch.  A changed host is refused; absent required routes instruct an update.  The caller supplies the accepted placement protocol version, so the library invents no release policy.  The health version remains the installed product version.  Handshake success returns evidence; it does not save, apply a mode or dispatch work.  Saved and applied selections remain distinct, and the composition layer must record applied state only after a controller acknowledgement.

## Verification And Delivery Boundary

Fixtures use temporary directories, synthetic credentials and URLProtocol responses; no real Keychain item or server is contacted.  They cover origin validation, private atomic storage, unreadable-file preservation, nonregular files, ownership/removal, stable pins, separate store instances, lock refusal, gate-header delivery, redirect policy and required handshake routes.  Independent source review found and corrected pin mutability, local-anchor validation, missing-route classification and file read/backup races before publication.

All 18 isolated Mac tests passed, including the parent-directory and hard-link refusal fixtures, and the renewed unsigned iOS Xcode build succeeded.  The full local Node gate is running against unchanged Node sources; no overall green result is claimed.  The native app does not construct this library yet, and no live migration, credential provisioning or service change occurred.  Control's saved-host file is untouched; its one-time import remains the later lifecycle slice.

```sh
swift test --package-path ios --jobs 2 --filter 'SavedHostsTests|ServerHandshakeTests'
pnpm typecheck
pnpm test
git diff --check
```

## Update And Rollback

This adds an unused native library and optional client argument.  Existing companion connections and Control storage retain their current paths.  The future composition must keep the app-owned host directory through updates and handle an unsupported store schema without rewriting it.  No live acceptance assertion is enabled by these fixtures.
