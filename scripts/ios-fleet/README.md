# BotFleet-local iOS fleet ship copy

Vendored from `/Users/jay/apps/ios-fleet` (same family as Congress.Trade
`scripts/ios-fleet`) so a GitHub-hosted `macos-latest` runner can ship
without that Mac path.  `apps.json` here is BotFleet-only: bundle
`app.botfleet.ios` (appleId `6820175685`), team `CC8UTF7ATG`, SKU `botfleet`,
marketing train `1.0`.

## Versioning

Owner directive 2026-10-24 (AFC-517):  the marketing version and the build
number are independent.

- `MARKETING_VERSION` is the next patch on the app's train:  `1.0.<P+1>`, where
  `P` is the highest patch App Store Connect already holds on that train
  (App Store versions AND TestFlight trains, drift trains ignored).
- `CURRENT_PROJECT_VERSION` is the repo commit count, raised above the App
  Store Connect floor (every build already in the target train, plus the app's
  own plain-integer builds) when it has to be.
- `--version` and `--build` are exact overrides; `--build` no longer moves the
  marketing version.

The rules live in `scripts/ios-fleet/version-plan.mjs` (pure, unit-tested by
`version-plan.node-test.mjs`); `ship-testflight.sh` applies them and prints a
`version plan:` line naming the patch and the floors it used.

Fixed versions (owner 2026-10-29): an app with `fixedMarketingVersion` in
`apps.json` (BotFleet: `0.1.0`) ships that version unchanged, and its build
is one shared merge-timestamp build, max(S, M + 1): S is the committer date
of HEAD in America/Chicago as YYYYMMDDHHMM, M is the highest build already
in App Store Connect on either platform. The rule lives in `shared-build.mjs`
(unit-tested by `shared-build.node-test.mjs`); the release workflow's
plan-build job computes it once (`ship-testflight.sh --plan-build-only`,
read-only) and every ship job of that release takes it as its `--build`.

`scripts/ios-ship-testflight.sh` prefers this directory, then falls back
to `/Users/jay/apps/ios-fleet` on Jay's Mac.

Hosted signing comes from existing repo Actions secrets
(`APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8_BASE64`,
`IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`).  `scripts/ios-appstore-gm-prepare.sh`
checks the p8 and imports the Distribution identity (the ship step decodes
the APPLE_API_* names into a private temp file).  On Jay's Mac the ASC key
comes from Infisical Fleet-OPS `/asc` (`ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8`) through `fleet-secrets`.  Do not mint a new App Store Connect key.  CI invokes the
wrapper with no extra flags.

The `.xcodeproj` is gitignored; hosted ships must run `xcodegen generate`
(the workflow installs xcodegen before the wrapper).
