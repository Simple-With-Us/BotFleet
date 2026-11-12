# DeepSeek Rate Display

The September 13 review found an obsolete flat rate table and an outdated V4 Flash label.  The live [official pricing page](https://api-docs.deepseek.com/quick_start/pricing/) reports V4.1 Flash and two billing windows.  Search-index excerpts still contained older values, so the live page body was checked directly.

BotFleet now displays off-peak–peak ranges for input, cache reads, and output, names the UTC peak windows, and dates its source.  The copy distinguishes API reference estimates from provider charges and subscription limits.  This change does not retrospectively reprice usage or alter DSH model selections.

## Validation

- Six DeepSeek/MiniMax pricing tests passed, including sub-cent cache precision.
- The real UsageSection rendered in a local browser fixture with network calls stubbed and external requests blocked.  Both price ranges and billing-window text were visible; no page errors or development overlay appeared.
- Screenshot: `docs/screenshots/deepseek-rates-20260913.png`.
- Complete hosted typecheck/test matrix remains the merge gate; no installed Mac update is claimed by this fixture.

Issue #396.  Board `beb8234081e546fd846143581e111226`.
