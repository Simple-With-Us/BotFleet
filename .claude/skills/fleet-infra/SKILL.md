---
name: fleet-infra
description: Access private fleet infrastructure inventory (host IPs, Tailscale mesh IPs, Coolify container UUIDs, Infisical project IDs, and SSH keys) maintained in Simple-With-Us/fleet-ops:ATTACK-MAP.md. Use when locating production servers, configuring environment variables, verifying edge routing, or handling infrastructure secrets without leaking them into public repos.
---

# Fleet Infrastructure & Private Inventory Access (ALL AGENTS)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


All fleet repositories except `fleet-ops` are **public**.  To protect origin infrastructure from direct attacks, scanning, and DDoS, production host IPs, Tailscale IPs, Coolify container/server UUIDs, hardware serials, and secret keys must **never** be committed to public repositories or printed to chat/logs.

## Canonical Inventory Location

- **Local Workstation Agents (Mac/Terminal):**
  Read `/Users/jay/Code/fleet-ops/ATTACK-MAP.md` privately.  Copy only the single field the task needs.  Never paste the file, a host list, or a Tailscale address into chat or a public repo.

- **Cloud / Remote Agents (without direct repo access):**
  Do not fetch `ATTACK-MAP.md` over HTTP.  A `curl` (or similar) with `Authorization: Bearer ${MAC_COLLAB_TOKEN}` puts the token on argv and dumps the whole inventory into the transcript.  Ask a Mac seat to read the file locally and return only the redacted field required for the task.

## What Lives in `fleet-ops:ATTACK-MAP.md`

1. **Host Topology & IP Addresses:**
   Production public IPs, Tailscale MagicDNS names, mesh IPs, workstation relay addresses, and retired-host notes.  None of those values belong in this public skill.

2. **Coolify Container & Server UUIDs:**
   Server and application UUIDs for Socratic.Trade, Congress.Trade, and Usage-Monitor.

3. **Infisical Project IDs:**
   Project workspace IDs for ST, CT, Shared, and UM scopes.

4. **Edge & Access Control Rules:**
   Cloudflare origin isolation, SSH restricted to the Tailscale mesh, and Coolify control-plane bind rules.

## Invariants for Public Repositories

1. **Never Hardcode Infrastructure IDs in Public Repos:**
   Always read values from environment variables (`INFISICAL_PROJECT_ID`, `COOLIFY_ST_APP_UUID`, `HETZNER_HOST_IP`, etc.) or query them dynamically via authenticated APIs.

2. **Secrets Handoff Protection:**
   Read credentials from `~/.secrets/global-api-keys` or Infisical.  Never `cat`, `grep -E '^[A-Z0-9_]+='`, or log secret values into transcripts.

3. **Mock Data in Tests & Documentation:**
   Use RFC 5737 documentation ranges (`192.0.2.1`, `198.51.100.1`, `203.0.113.1`) and generic mock UUIDs (`mock-app-uuid`, `mock-project-id`) in test fixtures and public rollouts.
