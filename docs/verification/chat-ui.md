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
