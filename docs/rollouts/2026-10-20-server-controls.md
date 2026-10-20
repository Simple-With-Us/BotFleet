# Independent Server Controls

## Summary

BotFleet now packages a separate native macOS menu bar controller for server and Local VM power actions.  Closing the last main BotFleet window quits Electron; the existing **Keep Server Running After Quitting BotFleet** preference governs the attached harness.  Hiding the controller's menu bar icon leaves that controller running, and its own Login Item preference is independent of server startup.

The controller reads status from local harness routes.  Stop Server refuses active bots, VM leases, setup changes and other admitted work before it writes the shutdown marker.  It fences new work through graceful shutdown and stops the managed shared and per-bot Local VMs without stopping the Docker or OrbStack daemon.  Start VM creates a missing shared VM; a stopped VM cannot safely resume under the current desktop image and must be recreated in Computer settings.  Its disk is preserved.

## Startup Policy

The tracked launchd wrapper has an opt-in `BF_CONTROL_STARTUP_POLICY_V1` marker contract.  `startup-disabled.marker` prevents a new-boot launchd start while allowing a deliberate manual start for the rest of that boot.  `startup-enabled.marker` allows a new-boot launchd start even after an earlier deliberate stop; a stop during the current boot stays in force.  With neither marker, the previous durable-stop behavior remains.  If both markers exist, disabled wins.  The native controller checks for the upgraded installed wrapper before changing this policy.

## Verification

- The independent controller's nine Swift tests, three native-control HTTP integration tests, wrapper fixture tests (33) and Electron installer/control tests (4) passed locally.  `pnpm typecheck` also passed after the final HTTP test edit.  The fixture tests use fake boot IDs, isolated data roots and injected VM actions; they do not contact the live harness or VM runtime.
- A Developer ID signed universal controller build, version 1.0.2149, was installed at `~/Applications/BotFleet Control.app` for inspection.  The local check confirmed both architecture slices, a strict valid signature, menu bar only behavior and an unchanged server listener.
- The full isolated Linux gate passed `pnpm typecheck` at commit `169767098`, then `pnpm test` failed 38 tests in seven files outside this change.  The same seven-file selection on clean `origin/main` in the same lane and runtime reproduced 37 failures across six files, including the ACP allowlist symlink case.  The additional `server/procs.test.ts` timeout passed all 29 tests when rerun on the feature head outside the full-suite load.  The remote gate is **not passed**; hosted CI on a non-root runner must decide the PR, and the baseline failures merit separate follow-up.

## Rollout And Follow-Ups

The tracked wrapper and server code are committed separately from the installed runtime.  The live `~/apps/botfleet-server-start.sh` wrapper and the running server have not been upgraded by this change.  A candidate patch for the installed wrapper was prepared against its current contents and passed `bash -n` plus all 33 fixture tests without applying it.  An authenticated live readiness check found `activeWorkCount=1`, `safeToRestart=false` and `quiescing=false`, so runtime rollout is held to preserve that work.  The live runtime reported an all-zero source commit, which does not establish exact build identity.  Startup toggles report that the installed wrapper needs an update until it exposes the V1 policy marker.  After landing, update the installed wrapper through the reviewed operations process, deploy a compatible server, then verify the controller against that runtime without interrupting active bots or VMs.  A stopped Local VM still requires explicit recreation in Computer settings.
