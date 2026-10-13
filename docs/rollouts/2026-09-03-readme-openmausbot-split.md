# 2026-09-03 — Drop Polar support links; rewrite README around BotFleet add-ons

Seat: GROK.  Branch `grok/readme-no-support-payments`, worktree `~/apps/botfleet-grok-readme`.  Board `1af79606`.  Issue #160.

## Why

The GitHub repo still carried OpenMausBot's Polar support-payment links (README "Support the project" plus `.github/FUNDING.yml`).  The README also pasted the large upstream Why / Features block instead of describing what this fork added.  Owner: Polar is their support link and does not belong on our page.  Social preview image is already set in GitHub and is not an app icon (new icons still to come).

## What landed

- Deleted `.github/FUNDING.yml` (Polar `supamaus` plus the buy.polar.sh custom URL).  That removes the GitHub Sponsor button that pointed at upstream.
- Removed the README "Support the project" section and every Polar link from product copy.
- Rewrote README: BotFleet add-ons first (including recently landed ones; all marked in testing), then a prominent [OpenMausBot](https://github.com/milind-soni/OpenMausBot) link and the feature list the fork inherited.  Kept Quick start / install / license.  Header tagline matches the owner social image: "Pick Any Platform For Each Bot" / "Use Your Subscriptions + APIs."
- Updated GitHub About description the same way.  Did not upload or replace the social preview image.
- botfleet.app: one In Testing add-on list (20 cards, recent features included) plus a From OpenMausBot block.  Fixed the doubled `/releases/releases` previous-builds link.  Fleet Recall copy does not name the private corpus (the no-owner-defaults scan forbids it on the public site).

## Verification

```bash
grep -RInE 'polar\.sh|Support the project' README.md apps/site .github || true
test ! -f .github/FUNDING.yml
node apps/site/build.mjs
gh repo view Simple-With-Us/BotFleet --json description
```

Docs and site copy only.  App icons untouched.

## Follow-ups

- After merge, confirm GitHub no longer shows a Sponsor / Polar button (FUNDING.yml deletion is what turns that off).
- botfleet.app Vercel deploy follows main when `apps/site` changes.
- New app-icon assets when the owner supplies them; do not reuse the social banner.
