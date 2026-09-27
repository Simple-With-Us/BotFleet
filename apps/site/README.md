# botfleet-site (apps/site)

The marketing / status site for **[BotFleet.app](https://botfleet.app)**.  A static page listing the add-on features BotFleet layered on after forking [OpenMausBot](https://github.com/milind-soni/OpenMausBot) (all of them in testing), then the features OpenMausBot already shipped when we forked.

## Deploy source of truth

This directory (`apps/site` in the `jaywedgeworth22/BotFleet` monorepo) is the **only** deploy source for `botfleet.app`.  Vercel project `botfleet-site` has Root Directory set to `apps/site` and builds (`npm run build` → `node build.mjs`) on every push to this monorepo's `main` — whatever is committed here is what ships, gated by `vercel-ignore-hourly.sh` (skips previews, skips commits that did not touch site files, production at most once per three hours unless `VERCEL_FORCE_DEPLOY=1`).  The cooldown requires `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` in the Vercel build environment; if either is missing or the Vercel deployment-status API fails, the ignored-build step skips the automatic production deploy rather than bypassing the limit. An empty successful deployment history permits the first deploy. `VERCEL_ORG_ID` is optional for team-scoped projects. There is no GitHub Actions workflow for the site in this monorepo; Vercel's own Git integration does the build, no Action needed.

A separate `jaywedgeworth22/botfleet-site` repo previously also deployed to the same Vercel project and the two fought over which build won.  That repo no longer exists (confirmed 404 via the GitHub API on 2026-09-02) so there is nothing left to disable.  If it is ever recreated or reconnected to the `botfleet-site` Vercel project, its deploy workflow must be disabled (or the project's Git integration repointed here) before it is allowed to push again — otherwise the dual-deploy race comes back.

## Stack

Static HTML/CSS rendered from `features.json` via `node build.mjs`, hosted on Vercel.  DNS is a Cloudflare zone (`botfleet.app`) on the Usage.Jays.Services account; the registrar is Namecheap with nameservers pointed at Cloudflare.

- `features.json` — the feature list (the only file to edit for content changes).
- `template.html` + `build.mjs` — render `index.html` from the data.
- `sync-status.mjs` — refreshes each card's PR state from GitHub and reports merged-but-unlisted PRs and promotion candidates; it never moves a card between sections on its own.
- `logo-256.png` / `icon-1024.png` / `apple-touch-icon.png` — the iOS/macOS app icon (white-background 1024 square).
- `favicon-64.png` / `icon-transparent-1024.png` — transparent just-bots mark (favicon).
- `hero-bots.png` / `wide-banner.png` / `wide-banner-transparent.png` — extra site art, white or transparent, as supplied.
- `.well-known/apple-app-site-association` — associated-domains file for the iOS app's Universal Links (`applinks:botfleet.app`) and shared web credentials (`webcredentials:botfleet.app`); appIDs use Team `CC8UTF7ATG` / bundle `app.botfleet`.  Must stay in sync with `ios/App/BotFleet.entitlements`.
- `vercel.json` — clean URLs plus a header rule that serves the AASA file as `application/json`.

## Updating the feature list

Edit `features.json`, run `node build.mjs`, commit `index.html` too, push to `main` — Vercel deploys.  Rules:

- Feature statuses: every BotFleet add-on is **In Testing**.  Do not add an Established section unless the owner asks.  The builder still hides any section with zero features.
- `node sync-status.mjs` after PRs merge; it updates PR states in `features.json` and prints merged PRs that have no card yet.  Adding a card stays a judgment call.  Do not promote cards out of testing.
- Owner copy rules apply: two spaces between sentences (a real U+00A0 plus a space in HTML strings — never the `&nbsp;` entity, which can leak as literal text), Title Case headings, light theme.
- No internal agent seat names on the public site.
- The bot roster is an example fleet, not a product claim — keep it framed that way.

Manual deploy fallback: `vercel deploy --prod` from `apps/site` (project `botfleet-site`).

## Coordination

Fleet coordination happens on THE BOARD and #agent-sync per the maintainer's `AGENT-SYNC.md`.  This directory mirrors its effort rows in `docs/EFFORT-LOG.md`.
