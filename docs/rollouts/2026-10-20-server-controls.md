# Independent Server Controls

## Summary

BotFleet now packages a separate native macOS menu bar controller for server and Local VM power actions.  Closing the last main BotFleet window quits Electron; the existing **Keep Server Running After Quitting BotFleet** preference governs the attached harness.  Hiding the controller's menu bar icon leaves that controller running, and its own Login Item preference is independent of server startup.

The controller reads status from local harness routes while the server is running.  When the server is deliberately stopped, its bundled Node helper reads only managed Docker names, states and labels from a local Unix socket; it can stop those VMs or create a shared VM without starting it.  Both paths refuse remote Docker contexts, and the offline mutation path requires a deliberate-stop marker, a free server port and an inactive LaunchAgent.  Stop Server refuses active bots, VM leases, setup changes and other admitted work before it writes the shutdown marker.  It fences new work through graceful shutdown and stops the managed shared and per-bot Local VMs without stopping the Docker or OrbStack daemon.  A newly created, never-started shared VM can start after its image, management labels, loopback viewer, security limits and durable workspace are verified.  A previously started and stopped desktop cannot safely resume and must be recreated in Computer settings; its disk is preserved.

The **Keep Server Running After Quitting BotFleet** setting is available while the server is off through an atomic, owner-private `persist-on-exit.policy` file.  The server and Electron read that strict local value first, falling back to the previous `config.json` setting when it is absent.  An online settings save updates both files so an older sidecar value cannot override a new choice.

## Startup Policy

The tracked launchd wrapper has an opt-in `BF_CONTROL_STARTUP_POLICY_V1` marker contract.  `startup-disabled.marker` prevents a new-boot launchd start while allowing a deliberate manual start for the rest of that boot.  `startup-enabled.marker` allows a new-boot launchd start even after an earlier deliberate stop; a stop during the current boot stays in force.  With neither marker, the previous durable-stop behavior remains.  If both markers exist, disabled wins.  The native controller checks for the upgraded installed wrapper before changing this policy.

## Verification

- The controller's original nine Swift tests, three native-control HTTP integration tests, wrapper fixture tests (33) and Electron installer/control tests (4) passed locally.  Later offline-control tests and the final signed build are recorded after the integration pass.  The fixture tests use fake boot IDs, isolated data roots and injected VM actions; they do not contact the live harness or VM runtime.
- A Developer ID signed universal controller build, version 1.0.2149, was installed at `~/Applications/BotFleet Control.app` for inspection.  The local check confirmed both architecture slices, a strict valid signature, menu bar only behavior and an unchanged server listener.
- The full isolated Linux gate passed `pnpm typecheck` at commit `169767098`, then `pnpm test` failed 38 tests in seven files outside this change.  The same seven-file selection on clean `origin/main` in the same lane and runtime reproduced 37 failures across six files, including the ACP allowlist symlink case.  The additional `server/procs.test.ts` timeout passed all 29 tests when rerun on the feature head outside the full-suite load.  The remote gate is **not passed**; hosted CI on a non-root runner must decide the PR, and the baseline failures merit separate follow-up.

## Rollout And Follow-Ups

The tracked wrapper and server code are committed separately from the installed runtime.  The live wrapper was upgraded passively from a fixture-tested patch, preserving its local drift.  The owner authorized stopping BotFleet work for resource sampling and Local VM recreation; the main app and server are now off, and the LaunchAgent is booted out with deliberate-stop and startup-disabled markers.  The current managed VM container was absent, while a compatible v8 image remained cached.  The signed controller and its offline helper must be rebuilt and verified before the owner uses the helper to create a new container in Docker's `created` state.  That operation must leave the server, app and VM off.  Main server deployment remains held; the live wrapper upgrade does not itself supply the new HTTP routes.
