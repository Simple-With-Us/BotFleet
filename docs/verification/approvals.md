# Approvals and the permission broker

The approvals fixture verifies peer approval denial, expiry, cancellation, and the permission broker's isolation of access control decisions.

## Setup

```sh
pnpm test -- server/delegations.test.ts
```

This test suite:

1. Starts an isolated server with multiple test bots
2. Creates approval chains (one bot requests, peer reviews)
3. Seeds time to control expiry windows
4. Tests denial, cancellation, and re-submission
5. Verifies the broker blocks unauthorized access

## Steps

```sh
# 1. Run the delegation and approval tests
pnpm test -- server/delegations.test.ts

# 2. Expected assertions:
# - Approval creation succeeds and generates a unique ID
# - Peer can deny, approve, or cancel pending approvals
# - Approved access grants the requested permission temporarily
# - Expired approvals block access automatically
# - Re-submitting after denial works and generates a new approval
# - Full Access approval does not require per-request approval for subsequent turns
```

## Expected Evidence

A passing run shows:

- **Test output:** All approval lifecycle, expiry, and cancellation tests pass
- **Permission log:** Server logs show grant/deny decisions with timestamps
- **Access blocking:** Attempting to use a resource without valid approval returns 403
- **Expiry:** After the approval window closes, access is denied even with a previously-granted approval

## Key Behaviors Verified

- **Peer approval denial:** A denied approval can be resubmitted; the denial does not block future requests
- **Expiry:** Approvals expire after a configurable window (typically 1 hour)
- **Cancellation:** An approver can cancel an active approval mid-window
- **Full Access:** A special approval grants access to all future requests for a time window without re-asking
- **Permission isolation:** The broker grants only the requested permission, never broader access

## Cleanup

The test suite cleans up automatically.  No manual cleanup is needed.
