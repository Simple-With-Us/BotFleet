# 2026-09-06 — Settings Remote Access for the Named Tunnel

**Why:** Jay's Tunnel is live at `https://botfleet.jays.services` (Cloudflare
Access, same idea as agents.jays.services, `/api/health` public).  Settings
needed a Remote Access surface that shows that URL as a readable, copyable
value and does not invent TryCloudflare for this path.

**What landed**

- Settings sidebar gains a **Remote Access** section.  Heading, Remote URL
  label, `https://botfleet.jays.services`, and the Designer blurb are exact.
- Phone keeps Companion Gateway as a separate card: agents.botfleet.app is
  another path and stays untouched until that sidecar is up.
- Custom Webhook Domain / TryCloudflare in Connections is unchanged.

**Not this surface**

iOS Settings is phone pairing to the companion sidecar, not the named-tunnel
web path to :8799.  Mixing `botfleet.jays.services` into iOS connection
address would point the phone at the harness.  macOS desktop is the same
Electron Settings modal.

**Board:** `a4b7edb0`.  **Issue:** #226.  **Branch:** `grok/remote-access-named-tunnel`.

**Security note (2026-10-15, BF-2129):** The tunnel forwards with a loopback `Host`, so the harness treats Access-authenticated traffic like local loopback for the Host gate.  Mutating `/api/*` requests that arrive with Cloudflare edge headers are refused until dedicated remote auth ships.  See `docs/verification/named-tunnel-loopback-host.md`.
