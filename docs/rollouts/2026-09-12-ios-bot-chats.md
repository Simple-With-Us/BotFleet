# iOS Bot Chats on the roster

Owner asked for bot-to-bot chats to sit separately on iOS, the way the Mac sidebar already does.

## Why

Mac files `group.dm` under **Bot Chats** (default collapsed, always at the bottom).  iOS `ChatListView` treated every room as a user room, so bot-to-bot DMs mixed into Channels/Rooms.

## Change

- User rooms stay in the Channels/Rooms section.
- Bot-to-bot DMs (`dm == true`) move to a **Bot Chats** section under Bots.
- First open is collapsed, same as Mac.  The choice persists in `companion.chats.botChatsExpanded`.
- The section hides when there are none.
- Search still finds them.

Extra-ship no.  No TestFlight.

## Files

- `ios/Sources/CompanionCore/Models.swift` — `Room.isBotToBot`
- `ios/App/Session.swift` — `Chat.isBotToBot`
- `ios/App/ChatListView.swift` — roster split
- `ios/Tests/CompanionCoreTests/DecodingTests.swift` — dm flag

## Verify

Designer does not compile.  CompanionCore decoding tests cover the dm flag.  CI iOS job is the compile gate.
