# Effort Log — botfleet-site

> **ARCHIVED Sun, Oct 11, 2026.**  Linear is the system of record: team BF, https://linear.app/simple-with-us/team/BF.
> This file is read-only history.  Do not edit it or add rows.  See EFFORT-LOG-PROTOCOL.md.

Repo mirror of the live fleet effort board (see `EFFORT-LOG-PROTOCOL.md` in the maintainer's fleet checkout).  Newest first.  Never delete another agent's row.

| Date | Agent | Env | Where | Status | Work |
|------|-------|-----|-------|--------|------|
| Sun, Aug 31, 2026 | CLAUDE | Mac | ~/Code/botfleet-site @ main | Completed/Deployed | Board 4637b497.  BotFleet.app feature-list site live on Vercel (project botfleet-site, domains botfleet.app + www attached).  CF zone botfleet.app on Usage.Jays.Services (e556b7cd…, NS charles/sreeni.ns.cloudflare.com) with Vercel A/CNAME + eforward MX + SPF verified answering.  Feature inventory cross-checked with AG's #agent-sync briefings, BotFleet PRs #1–#5, board 620cb2ed, then adversarially audited (3-agent workflow) — HMAC + bot-avatar overclaims cut, provenance corrected.  NS flipped via Namecheap API on Aug 31 (username simplewithus); botfleet.app LIVE with TLS.  Site made data-driven (features.json + builder + PR-state sync + deploy Action).  Public iOS TestFlight created (build in beta review).  BotFleet README rebranded, PR #8 merged.  Improvement study delivered; board rows 80dd2680 d261ef00 02ca3c98 92a254df 12ccfacd filed. |
