# botfleet-site (apps/site)

The marketing / status site for **[BotFleet.app](https://botfleet.app)**.  A static page listing the add-on features BotFleet layered on after forking [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (all of them in testing), then the features OpenMausBot already shipped when we forked.

## Deploy source of truth

This directory (`apps/site` in the `Simple-With-Us/BotFleet` monorepo) is the **only** deploy source for `botfleet.app`.  Builds (`npm run build` → `node build.mjs`) trigger on push to `main` — whatever is committed here is what ships, gated by `vercel-ignore-hourly.sh` (skips previews, skips commits that did not touch site files, production at most once per three hours unless forced).  Hosting credentials and project settings live in the private operations inventory and deployment environment.

A legacy standalone site repo previously also deployed to the same domain and the two fought over which build won.  That repo no longer exists, leaving this monorepo directory as the single source of truth.

## Stack

Static HTML/CSS rendered from `features.json` via `node build.mjs`, hosted on Vercel.  DNS is a Cloudflare zone for the product domain; the account, zone ids, registrar and nameserver values live in the private operations inventory.

- `features.json` — the feature list (the only file to edit for content changes).
- `template.html` + `build.mjs` — render `dist/index.html` from the data.
- `public-assets.mjs` — the allowlist of files the build copies into `dist/`.  A file is published only if it is listed here.
- `verify-output.mjs` — fails when `dist/` holds anything outside that allowlist (a `README.md`, a `docs/`, a `*.sh`, a `package.json`, an unlisted file).  Runs as part of `npm run build`, so a leak fails the deploy instead of shipping.
- `sync-status.mjs` — refreshes each card's PR state from GitHub and reports merged-but-unlisted PRs and promotion candidates; it never moves a card between sections on its own.
- `logo-256.png` / `icon-1024.png` / `apple-touch-icon.png` — the iOS/macOS app icon (white-background 1024 square).
- `favicon-64.png` / `icon-transparent-1024.png` — transparent just-bots mark (favicon).
- `hero-bots.png` / `wide-banner.png` / `wide-banner-transparent.png` — extra site art, white or transparent, as supplied.
- `.well-known/apple-app-site-association` — associated-domains file for the iOS app's Universal Links (`applinks:botfleet.app`) and shared web credentials (`webcredentials:botfleet.app`); appIDs use Team `CC8UTF7ATG` / bundle `app.botfleet`.  Must stay in sync with `ios/App/BotFleet.entitlements`.
- `vercel.json` — the build command, `outputDirectory: dist`, clean URLs, plus a header rule that serves the AASA file as `application/json`.

## What is published

`outputDirectory` is `dist/`, and only `dist/` is deployed.  It previously
was `.` — this folder — which put `README.md`, `docs/EFFORT-LOG.md`,
`vercel-ignore-hourly.sh`, `sync-status.mjs`, `build.mjs`, `template.html`,
`features.json`, and `package.json` at `https://botfleet.app/<name>`.
`node build.mjs` now clears `dist/` and writes only `index.html` plus the
`public-assets.mjs` allowlist; `node verify-output.mjs` asserts that and
fails the build if it is untrue.  `index.html` is generated, not committed.

## Updating the feature list

Edit `features.json`, run `node build.mjs` (or `npm run build`), push to
`main` — Vercel deploys.  Do not commit `dist/` or `index.html`.  Rules:

- Feature statuses: every BotFleet add-on is **In Testing**.  Do not add an Established section unless the owner asks.  The builder still hides any section with zero features.
- `node sync-status.mjs` after PRs merge; it updates PR states in `features.json` and prints merged PRs that have no card yet.  Adding a card stays a judgment call.  Do not promote cards out of testing.
- Owner copy rules apply: two spaces between sentences (a real U+00A0 plus a space in HTML strings — never the `&nbsp;` entity, which can leak as literal text), Title Case headings, light theme.
- No internal agent seat names on the public site.
- The bot roster is an example fleet, not a product claim — keep it framed that way.

Manual deploy fallback: `vercel deploy --prod` from `apps/site`.  The project name is in the private operations inventory, not here.

## Coordination

Fleet coordination happens on THE BOARD and #agent-sync per the maintainer's `AGENT-SYNC.md`.  This directory mirrors its effort rows in `docs/EFFORT-LOG.md`.
