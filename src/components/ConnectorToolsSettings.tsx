// Per-bot connector tool grants (Finding 1e). BotFleet has no offline
// catalog of Composio toolkits/tools on the client — the connection cards
// that name them are minted server-side, per conversation, when a bot
// actually reaches for one — so this stays a minimal text list rather than
// a checkbox grid: one Composio service slug per line, each granted every
// tool it has ("*"). Fine-grained per-tool grants are still reachable
// through the API directly; this editor only round-trips the common,
// whole-service case.
import { useEffect, useState } from "react";

import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";
import { CONNECTOR_SLUG_PATTERN, type ConnectorToolGrant } from "../../shared/connector-tools";

/** A visible sentence gap that survives HTML whitespace collapsing: a
 * non-breaking space (never collapsed) plus a regular space, built from a
 * char code rather than typed literally so no editor/transfer step can
 * silently flatten it back to two plain spaces. Mirrors BotSkillsPanel.tsx's
 * GAP — see CLAUDE.md's sentence-gap rule for why JSX needs this instead of
 * the plain "  " that prose/source files use. */
const GAP = `${String.fromCharCode(160)} `;

/** Recessed (bg-inset) with a left rail, so this reads as a sub-setting of the
 * Composio grant toggle above it rather than a second peer grant.  The textarea
 * then goes back to the raised bg-card: the old pairing had a raised card with
 * a recessed field, and inverting only the card would have flattened the field
 * into its own background. */

/** Named as the restriction it is, not as a second grant. The old
 * "Connected App Access" sat under "Connected Apps" with both toggles lit, so
 * a lit toggle here read as "more access" when it actually meant "less" —
 * the one state a reader cannot infer from the switch position alone. */
export const CONNECTOR_TOOLS_HEADING = "Restrict To Specific Apps";

/** One valid, lowercased slug per line or comma, deduplicated, in the order
 * first seen. Invalid lines are dropped rather than rejected outright —
 * this box is meant to be typed into casually, not validated like a form. */
export function parseConnectorSlugLines(text: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of text.split(/[\n,]+/)) {
    const slug = rawLine.trim().toLowerCase();
    if (slug && CONNECTOR_SLUG_PATTERN.test(slug)) seen.add(slug);
  }
  return [...seen];
}

/** The textarea's starting text: every granted service, one per line,
 * sorted for a stable read across renders. */
export function connectorSlugLinesFrom(connectorTools: Bot["connectorTools"]): string {
  if (!connectorTools) return "";
  return Object.keys(connectorTools).sort().join("\n");
}

export function ConnectorToolsSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: { connectorTools?: Record<string, ConnectorToolGrant> | null }) => void;
}) {
  const restricted = bot.connectorTools !== undefined && bot.connectorTools !== null;
  const [draft, setDraft] = useState(() => connectorSlugLinesFrom(bot.connectorTools));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(connectorSlugLinesFrom(bot.connectorTools));
  }, [bot.connectorTools, dirty]);

  const commit = () => {
    if (!dirty) return;
    setDirty(false);
    const grants: Record<string, ConnectorToolGrant> = {};
    for (const slug of parseConnectorSlugLines(draft)) grants[slug] = { tools: "*" };
    onPatch({ connectorTools: grants });
  };

  return (
    <div className="ml-4 rounded-r-xl border-l-2 border-hairline/40 bg-inset p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[14px] font-medium text-ink">{CONNECTOR_TOOLS_HEADING}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {restricted
              ? `This bot can use only the Composio apps listed below.${GAP}Every other connected app stays off limits.${GAP}Turn this off to give this bot all connected apps.`
              : `This bot can use every connected Composio app.${GAP}Turn this on to pick exactly which apps it may use.`}
          </div>
        </div>
        <button
          role="switch"
          aria-checked={restricted}
          aria-label={CONNECTOR_TOOLS_HEADING}
          onClick={() => {
            setDirty(false);
            if (restricted) {
              setDraft("");
              onPatch({ connectorTools: null });
            } else {
              setDraft("");
              // Starting a restriction with nothing typed yet must block
              // every tool, not fall back to unrestricted — the same
              // fail-closed default the server applies to an empty record.
              onPatch({ connectorTools: {} });
            }
          }}
          className={cn(
            "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
            restricted ? "bg-accent" : "bg-control",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
              restricted ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>

      {restricted && (
        <div className="mt-3">
          <textarea
            aria-label="Allowed Composio apps, one per line"
            className="min-h-[80px] w-full resize-none rounded-lg border border-hairline/40 bg-card px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
            placeholder={"gmail\ngithub\nslack"}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
            }}
            onBlur={commit}
          />
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
            {`One Composio app per line, using the name shown on its card in Connected Apps (gmail, github, slack, ...).${GAP}Leave this blank to block every connected app for this bot.`}
          </p>
        </div>
      )}
    </div>
  );
}
