# Companion And iOS Safety Follow-ups

Date: 2026-09-12

Owner: CODEX

Issues: #93, #291, #292, #310

Pull request: #323

## Result

Paired profile edits now stop at an explicit field boundary before the sidecar forwards them to the broader loopback profile route.  Identity, notification, avatar, voice, and model selection fields remain available; execution policy, connected-app policy, computer grants, cloud configuration, host paths, and persistent notes remain computer-only.  The native profile sheet no longer presents those computer-only controls.

Permission cards now describe provider-supplied `Always allow` choices as `Allow once` on the phone while preserving the original provider choice on the wire.  The companion does not offer or call the Mac-only standing-grant route.

Image uploads and reads share a PNG, JPEG, GIF, and WebP display contract.  Native chat and avatar flows convert other decodable images to JPEG before upload and reject images such as SVG that cannot be converted, preventing a successful upload that the paired client cannot later render.

Native engine edits preserve reasoning effort for the primary selection and every fallback.  The picker is populated from the server's advertised effort levels, and an unknown saved value remains in the model until the person explicitly selects a supported replacement.

A working room now offers Interrupt across setup, responder handoff, and active-provider phases, and sends both the room ID and the task ID currently on screen.  The sidecar admits the exact room-interrupt route, and the harness returns a conflict rather than interrupting when the room switched tasks first.

## Verification

- `pnpm exec vitest run companion/test/routes.test.ts companion/test/proxy.test.ts` — 90 passed.
- `cd ios && swift test` — 254 passed.
- `pnpm typecheck` — passed.
- Local unsigned `xcodebuild` could not select a destination because this Mac has no iOS Simulator runtime installed (`iOS 26.5 is not installed`).  A bounded official runtime download found iOS 26.5 (23F77), but transferred only 3.1 MB of 10.6 GB in roughly two minutes and was cancelled rather than left as a multi-day background job.  Hosted unsigned Xcode CI is the app-target compile gate for this change.

No live pairing, physical-device acceptance, or signed Mac rollout was performed in this lane.  A simulator screenshot is unavailable for the same missing-runtime constraint; user-visible acceptance remains open until hosted compile succeeds and a device or simulator with an installed runtime exercises the updated sheets and room action.
