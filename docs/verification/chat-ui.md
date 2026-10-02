# Chat UI, driven headlessly

The chat UI recipe verifies that the React renderer (`src/`) displays messages, tool calls, and bot responses correctly in an isolated fixture.  The test uses the real component hierarchy mounted by `src/App.tsx` in a disposable browser session.

## Setup

The fixture starts a test server with a fake engine and mounts the real renderer:

```sh
pnpm test -- src/App.test.ts
```

This runs an isolated Vitest suite that:

1. Starts the BotFleet server on a random free port
2. Creates a test bot through the API
3. Mounts the React app in a headless environment
4. Drives the composer and transcript through accessibility names

## Steps

```sh
# 1. Start the fixture and get the fixture handle
pnpm test -- src/App.test.ts 2>&1 | grep -E "fixture|botId|port"

# 2. Send a message through the composer
pnpm test -- src/App.test.ts --grep "sends a message"

# 3. Verify the transcript renders the reply
pnpm test -- src/App.test.ts --grep "transcript contains reply"

# 4. Take a screenshot of the rendered UI
pnpm test -- src/App.test.ts --grep "screenshot"
```

## Expected Evidence

A passing run produces:

- **Test output:** No `FAIL` entries; all assertions pass
- **Fixture log:** Server logs at the printed path show `POST /api/bots` (bot creation), `POST /api/bots/:id/tasks` (message send)
- **Transcript render:** The sent text, tool chips (if shown), and bot reply all appear in the accessibility tree
- **Screenshot (optional):** Visual confirmation of the chat UI with the sent message and reply

## Cleanup

Interrupt the test suite with Ctrl-C or wait for completion.  Vitest removes temporary fixture data automatically.  Server logs remain at the printed path.

## Running from a Worktree

To run in an isolated checkout without touching `~/Code/BotFleet`:

```sh
cd /Users/jay/apps/botfleet-claude-security
pnpm test -- src/App.test.ts
```

The test uses the repository's test fixtures and does not contact the harness on port 8799.

## Composer Draft Restore

The composer clears the moment Enter is pressed, so a second Enter cannot send the same text twice.  If the server refuses the send, or cannot be reached, the text, the attachment chips and the reply target come back.  Anything typed in the meantime is kept after the restored text.  This recipe proves it in a real browser, with the test answering every `/api` route itself.

### Setup

`vite preview` proxies `/api` to the local bot server on port 8799.  The spec answers every route with `page.route`, including the event stream, which it answers with a hello frame and ends, so no request leaves the page and a running install is never contacted.  Do not add a test to `tests/e2e/composer-draft.spec.ts` that lets a route fall through.

### Steps

```sh
# Unit seams: the merge, the restore into a conversation nobody has open,
# and the store reporting a refused or unreachable send.
pnpm exec vitest run src/lib/drafts.test.ts src/state/store.send-failure.test.tsx

# Browser behavior, the way CI runs it.
pnpm exec vite build
pnpm exec playwright test tests/e2e/composer-draft.spec.ts
```

A machine with no Playwright browser can run the same spec against the installed Chrome from an untracked config that sets `use: { channel: 'chrome' }` and a `baseURL` for a throwaway `vite` dev server.  Do not commit that config.

### Expected Evidence

- A 400 answer puts the text back in the box.
- A refused connection puts the text back in the box.
- A 202 answer leaves the box empty, and a second Enter sends nothing more.
- A 202 that arrives late does not bring the text back.
- A refusal that arrives late keeps what was typed meanwhile, with the failed message first.
- A refusal that arrives after switching to another bot leaves that bot's box alone, and the text is waiting on coming back.
- A refusal brings back a pasted-text chip and the quoted reply, and while the server is still thinking both are gone from the composer.
- Steer Now in a busy room gives the message back when the server refuses it.
- A room message held for a busy member goes out when the room settles, and is given back if the server refuses it then.
- A second room message held for a busy member joins the first instead of replacing it, and when the room settles they go out once, as one message.
- Two held room messages that the server refuses come back together in the box.

Before the fix, nine of these eleven failed: the restore cases with an empty box, and the held-message cases with the first message lost.  The two that passed are the controls for an accepted send.
