# Model fallback on quota exhaustion

The quota fallback fixture verifies that when one provider's quota is exhausted, BotFleet automatically retries using another configured engine.

## Setup

```sh
pnpm test -- server/turn-tools.test.ts
```

This test suite:

1. Starts an isolated server with multiple fake engines
2. Configures quota limits per provider
3. Simulates quota exhaustion on the primary provider
4. Verifies fallback to secondary providers
5. Checks that the response credits are accurate

## Steps

```sh
# 1. Run the turn-tools tests
pnpm test -- server/turn-tools.test.ts

# 2. Expected assertions:
# - Primary provider fails with quota exhaustion error
# - Server retries with next available provider
# - Response credits are deducted from fallback provider
# - Bot's turn completes successfully with fallback reply
# - User sees no interruption or error message
# - Fallback attempt is logged with timestamps
```

## Expected Evidence

A passing run shows:

- **Test output:** All fallback and quota tests pass
- **Server logs:** Show provider attempts: `primary exhausted, trying secondary`
- **Credit accounting:** Quota deduction happens from the successful fallback provider, not the failed primary
- **User experience:** The transcript shows the final reply with no indication of failure or retry

## Key Behaviors Verified

- **Automatic retry:** No user action required; fallback happens transparently
- **Quota tracking:** Each provider's quota is tracked independently
- **Credit accuracy:** Credits are charged only when a provider succeeds
- **Prioritization:** Primary provider is tried first; secondary is used only on failure
- **Configuration:** Bot owners can configure preferred provider order

## Cleanup

The test suite cleans up automatically.  No manual cleanup is needed.
