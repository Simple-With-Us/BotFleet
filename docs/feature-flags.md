# Feature flags

BotFleet uses [OpenFeature](https://openfeature.dev) for vendor-neutral
feature flags.  Call sites read flags through `getBool` / `getString` /
`getNumber` from `server/feature-flags.ts`; the underlying provider is a
private implementation detail and can be swapped without touching the rest
of the codebase.

## Why OpenFeature

- **Vendor-neutral API.**  The harness talks to a stable, open-source
  evaluation API.  Switching from the in-process `LocalConfigProvider` to
  GrowthBook, Hypertune, or Cloudflare Flagship is one import change in
  `server/feature-flags.ts` — every call site keeps reading `getBool` and
  friends.
- **Standard semantics out of the box.**  Reasoning (`STATIC`, `DEFAULT`,
  `ERROR`, …), error codes, evaluation context, and flag metadata follow
  the OpenFeature spec, not whatever each vendor invents.
- **Typed helpers.**  `getBool(key, fallback)` returns `Promise<boolean>`
  with no SDK-shaped wrapper leaking out — the call site stays a single
  line.

## Why `LocalConfigProvider` first

- **Zero infrastructure.**  No SaaS account, no API key, no proxy.  The
  flag table is a committed JSON file (`server/feature-flags.json`) read
  once at process start.
- **Immediate call sites.**  The pilot wires a real flag
  (`harness.experimentalAcpDriverV2`) into the ACP driver creation path so
  the round-trip is exercised on every harness boot, not just a unit test.
- **Inert by default.**  Aligned with the observability posture in
  [`docs/observability.md`](observability.md): a missing or empty
  `feature-flags.json` returns the fallback, no network call leaves the
  machine, and no SDK is loaded eagerly at module import time.

## Adding a flag

1. Add an entry to `server/feature-flags.json` with `defaultVariant` and a
   `variants` map whose values share the same type:

   ```json
   {
     "harness.experimentalAcpDriverV2": {
       "defaultVariant": "off",
       "variants": { "off": false, "on": true }
     }
   }
   ```

2. Read it from a call site:

   ```ts
   import { getBool } from "../feature-flags.ts";
   const experimental = await getBool("harness.experimentalAcpDriverV2", false);
   ```

3. The OpenFeature client queues evaluations that happen before
   `installLocalConfigProvider()` runs and resolves them once the provider
   is wired, so module-top-level reads are safe.

## Swapping providers later

`server/feature-flags.ts` is the only file that imports
`@openfeature/server-sdk`.  To swap to GrowthBook self-hosted on Coolify:

1. `pnpm add @openfeature/growthbook-provider` (or whatever the current
   OpenFeature provider package is for the target).
2. In `server/feature-flags.ts`, replace
   `installLocalConfigProvider(LocalConfigProvider.fromFile())` with the
   vendor-specific constructor and its config.
3. Keep the `getBool` / `getString` / `getNumber` exports identical so
   call sites don't change.

No call-site diff.  No SDK-shaped types escape the module.

## Files

| Path | Purpose |
| --- | --- |
| `server/feature-flags.ts` | `LocalConfigProvider` + typed helpers + install-once wiring |
| `server/feature-flags.json` | Committed flag table (one entry today) |
| `server/feature-flags.test.ts` | Vitest coverage for helpers, fallback, and disabled flags |
| `docs/feature-flags.md` | This document |

## Reference

- <https://openfeature.dev>
- <https://openfeature.dev/providers/> — provider catalog (GrowthBook,
  Hypertune, Cloudflare Flagship, ConfigCat, LaunchDarkly, Split, …)
