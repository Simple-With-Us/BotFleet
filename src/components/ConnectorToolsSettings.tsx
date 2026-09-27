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

export const CONNECTOR_TOOLS_HEADING = "Connected App Access";

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
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{CONNECTOR_TOOLS_HEADING}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {restricted
              ? `Limited to the apps listed below.${GAP}Every other connected app stays off limits to this bot.`
              : `Every connected app in this workspace, unrestricted.${GAP}Turn this on to limit this bot to specific apps.`}
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
            aria-label="Allowed connected apps, one per line"
            className="min-h-[80px] w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
            placeholder={"gmail\ngithub\nslack"}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDirty(true);
            }}
            onBlur={commit}
          />
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
            {`One app per line — the same slug shown on its connection card (gmail, github, slack, ...).${GAP}Leave this blank to block every connected-app tool for this bot.`}
          </p>
        </div>
      )}
    </div>
  );
}
