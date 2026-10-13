# Product reach: files, iPad, iMessage, APNs, Vercel cap

Tue, Sep 1, 2026.  Owner follow-up on the delta-audit deferrals.

## Why

Killed-app wake, iPad, iMessage, chat files on every platform, a real desktop download host, and Vercel auto-deploys capped at one production build per hour.

## What

- Chat `POST /api/attachments` accepts ordinary files (pdf, zip, office, audio/video, text) as well as images.  Pathless desktop drops and pastes upload instead of asking the user to save first.
- iOS composer: Photos picker, Files picker, drag-drop, clipboard paste, and iPad Cmd-V (`onPasteCommand`).  Prompt tags are disk paths (`<attached-image>` / `<attached-file>`), never `/api/attachments` URLs.
- iPad: `TARGETED_DEVICE_FAMILY` 1,2, `NavigationSplitView` on regular width, Return inserts a newline, bubble max width 560.
- Companion stores APNs device tokens and wakes disconnected phones when the harness emits `notify`.  Uses `APNS_P8_PATH` (default `~/.secrets/AuthKey_N3949G7CN6.p8`), team `CC8UTF7ATG`, bundle `app.botfleet`.  Needs a TestFlight/device build with the production `aps-environment` entitlement.
- `POST /api/desktop/open` runs `open -a BotFleet` so the phone can bring the Mac app forward.
- `com.jay.botfleet-imessage-relay` LaunchAgent loaded (Xcode Python.app).  Mapped 12 bot chats (Oracle through Director).  Packaged artifacts live at `Simple-With-Us/botfleet-releases` v0.1.38 (`BotFleet.dmg`).
- Vercel `commandForIgnoringBuildStep` skips preview auto-deploys and caps production at one per hour.  `VERCEL_FORCE_DEPLOY=1` or Dashboard Redeploy (ignore step unchecked) still ships immediately.
- Composio "remote deploy" is `pnpm broker:deploy` (`wrangler deploy` of `cloudflare/composio-broker`).  Live default URL `botfleet-composio.milindsoni201.workers.dev` returns Cloudflare 1042/404.  D1 `435bcde1-…` is not in Jay's Cloudflare accounts, and there is no `COMPOSIO_API_KEY` in the handoff file, so this pass did not mint a new database.

## Verify

```
pnpm exec vitest run server/attachments.test.ts companion/src/apns.test.ts src/lib/intake-files.test.ts
launchctl print gui/$(id -u)/com.jay.botfleet-imessage-relay
curl -sI https://github.com/Simple-With-Us/botfleet-releases/releases/latest/download/BotFleet.dmg
```
