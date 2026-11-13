# 2026-09-13 — Skip pointless Vercel production deploys

Board `0934111e`.  Branch `fx/vercel-skip-pointless`.

`apps/site/vercel-ignore-hourly.sh`: skip previews, skip when `apps/site` did not change, cap one production deploy per hour.
