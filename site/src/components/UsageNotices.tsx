// The two notices at the top of Settings → Usage → Engine Quotas that explain
// why scheduled work is not flowing: engines the dispatcher refuses to start,
// and fallback chains that are shorter at runtime than in the picker.  They
// live here, apart from the Usage panel's six data sources, so a visual spec
// can mount the real markup with fixed data (tests/e2e/usage-notices.visual.spec.ts).
import type { DoomedPair, RedundantChain } from "../../../src/components/UsageSection";

/** Bots whose engine the dispatcher is refusing to start.  Renders nothing when
 *  no pair is held.  `heldPairs` are the pairs already filtered to the ones that
 *  actually hold a bot; the heading counts BOTS, not pairs, because one bot
 *  whose primary and fallback both opened breakers is one bot being held. */
export function HeldBotsNotice({ heldPairs }: { heldPairs: readonly DoomedPair[] }) {
  if (heldPairs.length === 0) return null;
  const heldBotCount = new Set(heldPairs.map((pair) => pair.botId)).size;
  return (
    <div className="mb-2 rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
      <div className="font-medium text-ink">
        {heldBotCount === 1 ? "1 Bot Is Being Held" : `${heldBotCount} Bots Are Being Held`}
      </div>
      <div className="mt-1">
        These bots cannot start their engine, so their scheduled work is queued rather than failed
        &#8212; it runs on its own once the engine comes back.{" "} Each attempt is being counted, so this
        is not a stuck scheduler.
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {heldPairs.map((pair) => (
          <li key={`${pair.botId}:${pair.instanceId}`}>
            <span className="font-mono">{pair.instanceId}</span> for bot{" "}
            <span className="font-mono">{pair.botId.slice(0, 8)}</span> — failed to start{" "}
            {pair.consecutiveFailures} times
            {pair.lastError ? `: ${pair.lastError}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Bots whose configured fallback chain is longer than the runtime will walk.
 *  Renders nothing when there are none. */
export function RedundantChainsNotice({ redundantChains }: { redundantChains: readonly RedundantChain[] }) {
  if (redundantChains.length === 0) return null;
  return (
    <div className="mb-2 rounded-lg border border-hairline/25 bg-inset/30 px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
      {(() => {
        // Count BOTS, matching the held-engines notice: one bot with a
        // redundant bot-level chain and two redundant task overrides is
        // one bot, not three.
        const bots = new Set(redundantChains.map((chain) => chain.botId)).size;
        return bots === 1
          ? "1 Bot's Fallback Chain Is Shorter Than It Looks"
          : `${bots} Bots' Fallback Chains Are Shorter Than They Look`;
      })()}
      <ul className="mt-1.5 space-y-0.5">
        {redundantChains.map((chain) => (
          // A bot legitimately returns several rows — its own chain plus
          // one per task that overrides it — so keying by botId alone
          // collided, and counting rows claimed several bots where there
          // was one.
          <li key={`${chain.botId}:${chain.scope ?? "bot"}:${chain.threadId ?? "-"}`}>
            <span className="font-medium text-ink">{chain.name}</span>
            {/* Without this, a Projects bot with task overrides shows one
                unnamed row per task and the operator cannot tell which
                chain to fix. */}
            {chain.scope === "task" && (
              <>
                {"\u00a0\u00a0"}
                <span className="font-mono text-ink-secondary">
                  task {chain.threadId ? chain.threadId.slice(0, 8) : "?"}
                </span>
              </>
            )}
            {" — "}
            {chain.total} configured,{" "}
            {chain.effective} usable
            {chain.redundant.map((entry) => (
              <span key={`${entry.instanceId}:${entry.model}`}>
                {" "}
                (<span className="font-mono">{entry.model}</span>{" "}
                {entry.reason === "same-as-primary" ? "is the primary again" : "repeats an earlier entry"})
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
