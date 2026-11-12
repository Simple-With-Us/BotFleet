# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.  Use GitHub's private
vulnerability reporting on this repository:
[Simple-With-Us/BotFleet security advisories](https://github.com/Simple-With-Us/BotFleet/security/advisories/new).
You will get a response as soon as possible, normally within a few days.

This fork does not publish a security mailbox.  Do not email the upstream OpenMausBot
address for BotFleet findings.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only** and has no authentication by design — it trusts the
  local user.  Anything that makes it reachable from off-machine, or lets one local *unprivileged
  other user* drive it, is a vulnerability.
- Packaged desktop builds migrate API keys out of plaintext `~/.botfleet/config.json` into
  OS-encrypted Electron `safeStorage` (`credentials.bin`).  The UI is write-only (`configured`
  booleans out, never values).  Source or unpackaged installs may still hold keys in `config.json`
  until that migration runs.  Any path that echoes a stored secret back — API response, SSE event,
  log line, argv visible in `ps` — is a vulnerability.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions.  Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities.
- Spawning must never route user-influenced strings through a shell.  Report any `shell: true` /
  `cmd.exe` string-building you find.
