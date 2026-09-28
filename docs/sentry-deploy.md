# Sentry production deploy records (BotFleet)

`.github/workflows/sentry-deploy.yml` runs after a green `CI` workflow on `main`
and attaches a production deploy marker:

```bash
npx @sentry/cli releases deploys "$VERSION" new -e production
```

- `VERSION` = full 40-char git SHA (`workflow_run.head_sha`)
- `SENTRY_ORG=simple-with-us`, `SENTRY_PROJECT=botfleet`
- Does **not** call `releases new` (no second release creator)
- Soft-fail: warn + exit 0

Vercel hosts `apps/site` (and related web surfaces).  Org Vercel integration
`494377` does not currently mark production deploys on the `botfleet` project,
so this workflow is kept (not skipped).
