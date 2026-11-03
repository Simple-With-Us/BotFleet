# Single-Writer Cutover And `app.botfleet.server` Retirement Runbook (BF-2514)

The ordered steps that move the BotFleet control plane to a single writer and then retire the Mac's always-on harness.  Read [the single-writer contract](native-rewrite-single-writer-contract.md) first; it states the rule this runbook executes.  Every step here names the command, the expected output and what a failure means.

Nothing in this document has been executed.  As of Nov 2, 2026 the Mac's `app.botfleet.server` LaunchAgent is loaded and running and the server's `botfleet-server.service` is active, and both hosts run the same harness against their own store.

## The Gate

Three of these steps are not executable until another issue lands.  They are marked **(BF-2544)** and they are the server side of the cutover: making the server the writer, giving the Mac app a server to choose, and the ownership fence between a controller and its workers.  BF-2544 is held by another seat and is not finished.

| Step | Owner | Blocked on |
|---|---|---|
| 0 — Record the baseline | BF-2514 | nothing |
| 1 — Prove the server can be the writer | BF-2514 | BF-2544 for the tailnet reachability and the Mac app's host choice |
| 2 — Clear the shared surfaces off the Mac | BF-2514 | nothing |
| 3 — Point the Mac app at the server | **(BF-2544)** | BF-2544 |
| 4 — Prove the server in production | BF-2514 | Steps 1 to 3 |
| 5 — Retire the Mac's launch agent | BF-2514, run by the owner | Step 4 |
| 6 — Verify the retirement | BF-2514 | Step 5 |

Step 5 is the only step that stops a live process, and it is the owner's to run.  Steps 0 to 4 are read-only or scope-narrowing and are safe to run at any time.

## Step 0 — Record The Baseline

Run on both hosts before anything changes, and keep the output.  It is the comparison the later steps are judged against, and it is the record of what the Mac's store looked like at the moment it stopped being the writer.

**On the Mac:**

```bash
launchctl print gui/$(id -u)/app.botfleet.server | sed -n '1,12p'
```

Expected: a block that names `path = /Users/jay/Library/LaunchAgents/app.botfleet.server.plist`, `state = running`, a `pid =`, `runs =`, and `last exit code = 0`.

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8799|8800)\b'
```

Expected: two lines, both `127.0.0.1`, owned by the same node pid — one on `8799` and one on `8800`.

```bash
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
```

Expected: `{"app":"botfleet","pid":<n>,"static":…,"ready":true,"booting":false}`.

```bash
curl -sf -m 5 http://127.0.0.1:8799/api/routines \
  | jq -r '.routines[]|select(.enabled)|.id' | sort > /tmp/mac-routine-enabled.txt
curl -sf -m 5 http://127.0.0.1:8799/api/webhooks \
  | jq -r '.webhooks[]|select(.enabled)|.endpointId' | sort > /tmp/mac-webhook-enabled.txt
wc -l /tmp/mac-routine-enabled.txt /tmp/mac-webhook-enabled.txt
```

Expected on Nov 2, 2026: `16` enabled routines and `6` enabled webhooks.

```bash
cat ~/.botfleet/harness-owner.json | jq -c .
```

Expected: `{"version":1,"pid":<n>,"port":8799,"nonce":"<64 hex>"}`.  This record is the rollback handle for Step 5's first half; leave it alone.

**On the server:**

```bash
systemctl is-active botfleet-server.service
systemctl show botfleet-server.service -p MainPID
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
```

Expected: `active`, a `MainPID`, and `{"app":"botfleet","pid":<n>,"static":true,"ready":true,"booting":false}`.

```bash
curl -sf -m 5 http://127.0.0.1:8799/api/routines \
  | jq -r '.routines[]|select(.enabled)|.id' | sort > /tmp/srv-routine-enabled.txt
curl -sf -m 5 http://127.0.0.1:8799/api/webhooks \
  | jq -r '.webhooks[]|select(.enabled)|.endpointId' | sort > /tmp/srv-webhook-enabled.txt
wc -l /tmp/srv-routine-enabled.txt /tmp/srv-webhook-enabled.txt
```

Expected on Nov 2, 2026: `1` enabled routine and `0` enabled webhooks.

**The overlap:**

```bash
comm -12 /tmp/mac-routine-enabled.txt /tmp/srv-routine-enabled.txt
comm -12 /tmp/mac-webhook-enabled.txt /tmp/srv-webhook-enabled.txt
```

Expected on Nov 2, 2026: one routine id and nothing else.

```bash
comm -12 /tmp/mac-routine-enabled.txt /tmp/srv-routine-enabled.txt \
  | while read -r id; do
      curl -sf -m 5 http://127.0.0.1:8799/api/routines | jq -r --arg id "$id" '.routines[]|select(.id==$id)|.name'
    done
```

Expected: `Fleet RAG Nightly Ingest`.  That routine is enabled on both hosts with the same schedule and the same `nextRunAt`, so two schedulers own one occurrence, which is the one live double-write the inventory found.  Two schedulers owning one occurrence is the defect, whether or not both executions succeed.  On Nov 2 the server's run failed and the Mac's was missed, because the Mac was offline;  the next occurrence is the first in which two completed executions are possible.

**A failure here** — a routine id on both lists, or a webhook endpoint on both lists — is the double-write to clear in Step 2, not a reason to stop.

## Step 1 — Prove The Server Can Be The Writer

**(BF-2544)** for the first two checks.

```bash
# On the server, over the tailnet, behind the owner gate.
curl -sf -m 10 -H "x-botfleet-gate-token: $BF_GATE_TOKEN" http://100.69.77.26:8799/health | jq -c .
```

Expected: the health object.  The token is read from Infisical (`fleet-secrets get`, never echoed, never in a command line argument that lands in a shell history) and is exported into the environment only for this command.

```bash
# On the server: the harness's own vault is configured and live.
curl -sf -m 5 http://127.0.0.1:8799/api/infisical/status \
  | jq -r '.infisical | "configured=\(.configured) enabled=\(.enabled) source=\(.source) vaults=\(.vaultCount) lastError=\(.lastError)"'
```

Expected: `configured=true enabled=true source=env vaults=44 lastError=null`.  The vault count moves as the vault changes; the other three values do not.

```bash
# On the Mac, for comparison: the Mac's vault is off, which is why its Zulip bots are disabled.
curl -sf -m 5 http://127.0.0.1:8799/api/infisical/status \
  | jq -c '.infisical | {configured, enabled, source, vaultCount}'
```

Expected today: `{"configured":false,"enabled":false,"source":"none","vaultCount":0}`.  This is a separate gap from the cutover:  it is why the Mac cannot be a fallback Zulip writer, and the rollback section says so.

```bash
# On the server: the service comes back on its own.
systemctl is-enabled botfleet-server.service
```

Expected: `enabled`.

**A failure here** — the tailnet health check refused, or the vault status does not answer `configured=true` — means the server cannot yet be the writer.  Stop here; this is BF-2544's work, not a cutover failure.

## Step 2 — Clear The Shared Surfaces Off The Mac

The Mac is stepping aside, so every surface enabled on the Mac and also enabled on the server is disabled **on the Mac**, before the Mac's harness is stopped.  Disabling it after the stop would leave the server firing a routine nobody can see and the Mac firing the same one nobody has retired.

For the one routine the inventory found:

```bash
# On the Mac.
curl -sf -m 5 -X PATCH http://127.0.0.1:8799/api/routines/6d74f498-e2b1-4582-bbb9-3919886e012b \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | jq -r '.routine.enabled'
```

Expected: `false`.

```bash
curl -sf -m 5 http://127.0.0.1:8799/api/routines \
  | jq -r '.routines[]|select(.enabled)|.id' | sort > /tmp/mac-routine-enabled.txt
comm -12 /tmp/mac-routine-enabled.txt /tmp/srv-routine-enabled.txt
```

Expected: **no output**.  That is the proof that the double-write is closed.

The same shape applies to a webhook endpoint that is ever enabled on both hosts:

```bash
curl -sf -m 5 -X PATCH http://127.0.0.1:8799/api/webhooks/<endpointId> \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | jq -r '.webhook.enabled'
```

Expected: `false`.

**Do not** disable the Mac's remaining fifteen enabled routines as part of this step.  They are Mac-side work with no server-side twin, and the Mac's store is not migrated by this cutover.  They stop firing when the Mac's harness is stopped in Step 5, and the inventory in Step 0 is the record of what they were.

**A failure here** — the `comm` output is not empty — means the double-write is still open.  Do not proceed to Step 5.

## Step 3 — Point The Mac App At The Server

**(BF-2544).**  The Mac app must read and write through the server, and the local `127.0.0.1:8799` must no longer be its target.  BF-2544 owns the saved-server list, the gate token and the handshake; this step is the check, not the implementation.

```bash
# On the Mac, after the app has been pointed at the server.
curl -sf -m 10 -H "x-botfleet-gate-token: $BF_GATE_TOKEN" http://100.69.77.26:8799/health | jq -c .
```

Expected: the server's health object, carrying the **server's** pid and not the Mac's.  The two pids are different by construction, so this is the check that the app is talking to the writer rather than to a leftover local harness.

```bash
# On the Mac: the local harness is still up but is no longer the target.
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
```

Expected: still a 200 at this point.  The local harness is stopped in Step 5, not here; until then it is a reader that nobody is using.

**A failure here** — the app still reaches `127.0.0.1:8799` — means the cutover would strand every Mac-side action on a harness that is about to be retired.

## Step 4 — Prove The Server In Production

One full day, with the Mac's harness running but unused, and the server serving every bot, routine, webhook, Zulip event and iOS push.

```bash
# On the server, repeatedly, across the day.
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
journalctl -u botfleet-server.service --since "24 hours ago" | grep -c "inbound-message"
```

Expected: the health object on every call, and a non-zero `inbound-message` count with no gap across the day.

```bash
# On the server: the shared routine fires exactly once per day, from the server.
curl -sf -m 5 http://127.0.0.1:8799/api/routines \
  | jq -r '.runs[]|select(.routineId=="6d74f498-e2b1-4582-bbb9-3919886e012b")|.startedAt' | tail -3
```

Expected: one run per day, all from the server.

```bash
# On the Mac: the local harness is idle, and the shared routine does not fire there.
curl -sf -m 5 http://127.0.0.1:8799/api/routines \
  | jq -r '.runs[]|select(.routineId=="6d74f498-e2b1-4582-bbb9-3919886e012b")|.startedAt' | tail -3
```

Expected: no new run since Step 2 disabled it.

This is the soak the decommission runbook's Step 2 names as the precondition for BF-2515: `soak-24h-no-node`.

## Step 5 — Retire The Mac's Launch Agent

**This step stops a live process and is the owner's to run.**  It is the last step, and the step before it belongs to BF-2544.

Run on the Mac.

```bash
# 0. Confirm the gate one more time, on the Mac, immediately before.
launchctl print gui/$(id -u)/app.botfleet.server | grep -E 'state = |pid = '
curl -sf -m 10 -H "x-botfleet-gate-token: $BF_GATE_TOKEN" http://100.69.77.26:8799/health | jq -c .
```

Expected: the Mac job is `running`, and the server answers.  If either fails, stop and go back to Step 1.

```bash
# 1. Disable the job so a later login cannot re-register it.
launchctl disable gui/$(id -u)/app.botfleet.server
```

Expected: no output and exit 0.

```bash
# 2. Boot the job out.
launchctl bootout gui/$(id -u)/app.botfleet.server
```

Expected: no output and exit 0.

```bash
# 3. Verify the job is gone.
launchctl print gui/$(id -u)/app.botfleet.server
```

Expected: `Could not find service "app.botfleet.server"` and a non-zero exit.  This is the exact check the decommission runbook's Step 2 names.

```bash
# 4. Verify nothing is listening on the Mac's harness ports.
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(8799|8800)\b'
```

Expected: **no output**.  Anything else means a process still holds the port, and the cutover is not complete.

```bash
# 5. Verify the launchd disabled map holds.
launchctl print-disabled gui/$(id -u) | grep 'app.botfleet.server'
```

Expected: `"app.botfleet.server" => true`.

```bash
# 6. Remove the installed plist and the wrapper, and keep the tracked source until the
#    decommission commit removes it.
rm ~/Library/LaunchAgents/app.botfleet.server.plist
rm ~/apps/botfleet-server-start.sh
```

Expected: both removed.  The repository copies — [scripts/launchd/app.botfleet.server.plist](../scripts/launchd/app.botfleet.server.plist) and [scripts/botfleet-server-start.sh](../scripts/botfleet-server-start.sh) — stay in the tree until BF-2515's Step 5 deletes them, because the runbook's rollback needs them and because the Linux deployment's source closure is BF-2544's to settle.

**Then update the Mac's process inventory** at `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`: the `app.botfleet.server` row and the `~/apps/botfleet-server-start.sh` row become retired, with the date and the reason, and the row states that the job is **always-on** while it existed.  Refresh the Apple Note `[BF, MM] Single-Writer Cutover` in the same change with `apple-notes-coding.sh --update`.

## Step 6 — Verify The Retirement

```bash
# On the Mac.
launchctl print gui/$(id -u)/app.botfleet.server
lsof -nP -iTCP:LISTEN | grep -E ':(8799|8800)\b'
ps -eo pid,command | grep -E 'server/index.ts' | grep -v grep
```

Expected: the service is not found, nothing is listening, and no harness process is running.

```bash
# On the server.
systemctl is-active botfleet-server.service
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
```

Expected: `active`, and the health object.

```bash
# From a client, the app still works.
curl -sf -m 10 -H "x-botfleet-gate-token: $BF_GATE_TOKEN" http://100.69.77.26:8799/health | jq -c .
```

Expected: the health object.

Then the functional set, once each: a bot answers a Zulip message, a routine fires on schedule, a GitHub webhook is received and acted on, a Linear round-trip completes, and a paired phone receives a push.

## Rollback

The rollback restores the old writer; it does not roll back code.

```bash
# On the Mac.
launchctl enable gui/$(id -u)/app.botfleet.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.botfleet.server.plist
launchctl kickstart -k gui/$(id -u)/app.botfleet.server
curl -sf -m 5 http://127.0.0.1:8799/health | jq -c .
```

Expected: the health object with the Mac's pid.

Two things have to be true before the Mac's harness resumes writing, or the double-write returns with a new name.

1.  The server must stop the surfaces the Mac is about to take back.  Re-disable `6d74f498` on the server, and any webhook endpoint enabled on both.
2.  The Mac's Zulip bridge needs a vault it does not have.  `GET /api/infisical/status` on the Mac answers `configured: false`, `enabled: false`, `source: "none"`, `vaultCount: 0`, so every scoped read is refused before a request is made and the Mac's Zulip bots stay disabled after a rollback.  Restoring the Mac's Zulip subscription means turning its Infisical configuration on and giving it a credential that can read the AI Fleet Coordinator `prod` `/zulip` folder, which is a change to a live harness's configuration and therefore its own approval.  A rollback that leaves the Mac's Zulip disabled and the server's enabled is a valid, honest rollback: the server stays the writer for Zulip, and the Mac is a local worker again.  The LaunchAgent's environment carries `HOME`, `PATH` and `BOTFLEET_SERVER_ROOT` and nothing else, so the Mac's Zulip bots stay disabled after a rollback.  Restoring the Mac's Zulip subscription means giving the LaunchAgent an Infisical project id and token, which is a change to a live launch agent's environment and therefore its own approval.  A rollback that leaves the Mac's Zulip disabled and the server's enabled is a valid, honest rollback: the server stays the writer for Zulip, and the Mac is a local worker again.

The Mac's store was never migrated by this cutover, so restoring the writer needs no data restore.  If a separate archive or re-import was performed, restore it the way BF-2515's Step 1 describes, before the harness is booted.

## Evidence To Record

When the cutover runs, the following belong in the BF-2514 issue, and BF-2515's `soak-24h-no-node` and `control-disposition` evidence depend on them.

-  The Step 0 baseline output from both hosts.
-  The Step 2 `comm` output showing no id enabled on both hosts.
-  The Step 4 soak: the dates, the inbound-message count, and the single daily run of the shared routine.
-  The Step 3 output showing the Mac app reaching the server's pid.
-  The Step 5 output showing `Could not find service "app.botfleet.server"` and an empty listener list.
-  The date of the Apple Note refresh and the inventory rows updated.

## What This Runbook Does Not Cover

-  The native app's own composition, which is MC's lane.
-  The Node-removal validation and the decommission commit, which are BF-2515 (AG).
-  The Linux source closure, which is BF-2544 with `docs/native-rewrite-linux-source-retention.md`.
-  The epoch fence between a controller and its workers, which is the design in `docs/plans/2026-10-29-native-server-mode.md`.  Until it lands, the discovery method in the contract — exactly one of the two launch paths may be live — is the only answer a reader has.
