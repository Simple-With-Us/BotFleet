# 2026-09-03 — Trio app icon on iOS and macOS; transparent-bots favicon

Seat: GROK.  Branch `grok/app-icons-trio`, worktree `~/apps/botfleet-grok-icons`.  Board `a959d7bf`.  Issue #164.

## Why

Owner supplied art in `/Users/jay/Code/Icons - Logos/BotFleet`.  The file labeled iOS (`botfleet-ios-app-icon-1024x1024.png`, now 1024) is the iOS and macOS app icon.  The transparent just-bots mark is the favicon.  Other white/transparent banners stay on the site.  The GitHub social image is already set and is not an app icon.

## What landed

- iOS `AppIcon.appiconset/icon-1024.png` is the owner's 1024 square, RGB 24-bit (App Store forbids alpha).  Art was not resized; unused alpha was dropped.
- macOS `build/icon.icns` / `icon.iconset` / `electron/resources/app-icon.png` / Linux `build/icon.svg` / Windows `build/icon.ico` use the same iOS-labeled art.
- Favicon (`apps/site/favicon-64.png`, `public/app-icon.svg`, `public/favicon-64.png`) uses `transparent-icon-1024x1024.png`.
- Site also carries `hero-bots.png` (BotsOnly), `icon-transparent-1024.png`, `wide-banner.png`, and `wide-banner-transparent.png` for white or transparent use.

## Verification

```
file ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
# PNG 1024 x 1024, 8-bit/color RGB, non-interlaced
```

Corners are opaque white (full-bleed square, not a pre-baked squircle).
