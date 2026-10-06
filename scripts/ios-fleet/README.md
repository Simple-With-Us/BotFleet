# BotFleet-local iOS fleet ship copy

Vendored from `/Users/jay/apps/ios-fleet` (same family as Congress.Trade
`scripts/ios-fleet`) so a GitHub-hosted `macos-latest` runner can ship
without that Mac path.  `apps.json` here is BotFleet-only: bundle
`app.botfleet`, team `CC8UTF7ATG`, SKU `botfleet`, marketing `1.0.N`,
build UTC `YYYYMMDDHHMM`.

`scripts/ios-ship-testflight.sh` prefers this directory, then falls back
to `/Users/jay/apps/ios-fleet` on Jay's Mac.

Hosted signing comes from existing repo Actions secrets
(`APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8_BASE64`,
`IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`).  `scripts/ios-appstore-gm-prepare.sh`
writes `~/.secrets/appstore-connect.env` and imports the Distribution
identity.  Do not mint a new App Store Connect key.  CI invokes the
wrapper with no extra flags.

The `.xcodeproj` is gitignored; hosted ships must run `xcodegen generate`
(the workflow installs xcodegen before the wrapper).
