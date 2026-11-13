// Which computer destinations an engine can actually reach.
//
// Before this file the answer existed five times: three expressions at the
// top of the 1:1 dispatch in `server/index.ts` (`mountsComputerMcp`,
// `mountsCloudComputer`, `mountsLocalComputer`), a fourth copy in the room
// dispatch, the two rejections inside `vpsDriverError`, and a hand-written
// mirror of all of them in `src/lib/local-computer.ts` so the picker could
// gray a destination out.  Nothing held them together, so they drifted: the
// client offered "This computer" to any engine with `computerMcp`, which the
// server never mounts it for, and it offered Cloud to the box-native engine
// even when that bot's cloud backend resolved to a self-hosted VPS, which
// `vpsDriverError` refuses.  Both drifts ended the same way — the person
// picked a destination the button offered, sent work, and found out when the
// turn died.
//
// So the reach is DERIVED here, once, from flags the drivers already
// declare.  No driver states its reach directly; a driver states how it can
// drive a computer at all, and the destinations follow from that.  Adding a
// destination to an engine is therefore a change to this file plus the
// executor that makes it real, never a flag flipped in a driver.
//
// This module is deliberately dependency-free: it imports no `node:*`
// builtin, nothing from `server/index.ts`, and nothing that reaches it.  The
// CLIENT imports it — the same way `src/components/UsageSection.tsx` imports
// `server/quota-window-map.ts` — so everything it can see has to be
// importable inside a renderer bundle.  `computer-capability.test.ts`
// asserts the ban rather than trusting it.

import type { ComputerKind } from "./computer-grants.ts";

/** How an engine drives a computer at all.
 *
 * - `remoteAgent` — the agent itself runs on the remote machine.  ASCII.dev
 *   Box is the only one: the turn happens on the box, so there is no local
 *   agent to mount anything INTO.  That is why it reaches its own box and
 *   nothing else — not a VPS (`vpsDriverError` says so in the person's
 *   words), not a Local VM, and not the host, because a remote agent has no
 *   channel back to this Mac's approval broker.
 * - `mcpClient` — the engine is an MCP client, so the harness can mount any
 *   computer as an MCP server beside the agent.  Every destination is
 *   reachable; the host still needs its own flag, because host control is
 *   the one destination that requires an approval channel rather than just a
 *   transport.
 * - `harnessToolLoop` — the harness runs the tool rounds itself inside
 *   `sendTurn` and hands the engine plain tool definitions.  That reaches
 *   the host tools this harness executes, and nothing that is only available
 *   as a mounted MCP server. */
export type ComputerTransport = "mcpClient" | "harnessToolLoop" | "remoteAgent";

/** The driver flags this derivation reads — a structural subset of
 *  `ProviderAdapter["capabilities"]`, so a server instance's capabilities and
 *  an `InstanceInfo`'s both satisfy it without a cast. */
export interface ComputerCapabilityFlags {
  computerMcp?: boolean;
  localComputerMcp?: boolean;
  toolLoop?: boolean;
}

export interface ComputerCapabilityInput {
  driverKind: string;
  capabilities?: ComputerCapabilityFlags | null;
}

/** Every computer kind, answered.  It extends `Record<ComputerKind, boolean>`
 *  rather than listing four fields on its own so a kind added to
 *  `ComputerKind` cannot be quietly skipped here. */
export interface ComputerReach extends Record<ComputerKind, boolean> {}

const NO_REACH = { box: false, vps: false, vm: false, local: false } satisfies ComputerReach;

/** Order matters and is not arbitrary.  `boxAgent` is asked first because a
 *  remote agent's reach is a property of WHERE the turn runs, which no MCP
 *  flag can widen.  `computerMcp` is asked before `toolLoop` because an
 *  engine that can mount MCP servers reaches strictly more than one that can
 *  only be handed tool definitions, so the wider transport wins. */
export function computerTransport(input: ComputerCapabilityInput): ComputerTransport | null {
  if (input.driverKind === "boxAgent") return "remoteAgent";
  if (input.capabilities?.computerMcp === true) return "mcpClient";
  if (input.capabilities?.toolLoop === true) return "harnessToolLoop";
  return null;
}

/** The destinations this engine can be given, before anything situational.
 *
 * This answers capability only.  Whether the engine is installed and
 * authenticated, whether a Box API key is configured, whether the VPS alias
 * resolves, whether CUA has been granted Accessibility — all of that is
 * readiness, decided at the call site.  Keeping the two apart is what lets
 * the picker say "this engine cannot" in words that stay true after the user
 * fixes their setup. */
export function computerReach(input: ComputerCapabilityInput): ComputerReach {
  const local = input.capabilities?.localComputerMcp === true;
  switch (computerTransport(input)) {
    case "mcpClient":
      return { box: true, vps: true, vm: true, local };
    case "remoteAgent":
      return { box: true, vps: false, vm: false, local: false };
    case "harnessToolLoop":
      return { ...NO_REACH, local };
    default:
      // No transport at all: an ACP engine configured without MCP servers
      // reaches nothing, and that is already what the server does today.
      //
      // Note what this branch does with `local`: it DISCARDS it.  That is the
      // one cell where the derivation deviates from the rule it replaced —
      // `server/index.ts`'s `mountsLocalComputer` read `localComputerMcp`
      // alone, so it would have answered true for an engine with no transport
      // at all.  Deliberate: a transport is how the harness can hand an engine
      // a computer in the first place, and an engine it can neither mount an
      // MCP server into nor hand tool definitions to has no way to be given
      // the host either.  No shipped driver occupies the cell —
      // `server/drivers/acp/core.ts` sets `computerMcp` and `localComputerMcp`
      // from the one `mountsMcpServers` boolean, and every other built-in
      // pairs `localComputerMcp` with `computerMcp` or `toolLoop` — which is
      // why the engine-for-engine parity test still passes.  It is pinned as a
      // deviation in `computer-capability.test.ts` rather than left to be
      // rediscovered.
      return { ...NO_REACH };
  }
}
