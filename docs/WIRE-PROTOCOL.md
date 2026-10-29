# Wire Protocol (Desktop ↔ iOS Companion)

This document tracks **cross-surface field vocabularies** that must stay aligned between the harness, desktop app, and iOS companion.  Breaking changes require bumping `/v1/info` only when older clients cannot ignore the new value.

## Bot profile: `avatarCrop`

| Raw value | Meaning |
|---|---|
| `mascot` | Deterministic vector mascot (default) |
| `tvface` | TV-Face enter/hold/return player (FleetLink packs by bot color) |
| `circle` | Uploaded image, circular mask |
| `rounded` | Uploaded image, rounded-rect mask |
| `square` | Uploaded image, square mask |

**Upload behavior:** When the user saves a custom image while `avatarCrop` is `mascot` or `tvface`, clients normalize to `circle` so the new attachment is visible (`shared/bot-avatar.ts` `avatarCropAfterUpload`).

**Decoding:** Unknown future values fall back to `mascot` on iOS (`DecodingTests.testFutureAvatarCropFallsBackWithoutDroppingTheBot`).
