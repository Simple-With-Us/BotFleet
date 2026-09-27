// Imported Agent Skills, on the bot profile.
//
// `server/skills.ts` states the policy this panel exists to carry out: an
// import lands DISABLED, the UI shows the full SKILL.md and the scan
// warnings, and a person enables it after reading.  Until this panel
// existed the server enforced the first half and nobody could do the
// second — the routes shipped with no screen, so no imported skill could
// ever be turned on.
//
// So the gate here is the product, not decoration: Enable stays disabled
// until this session has opened that skill's SKILL.md.  A person who has
// not read the text cannot consent to it reaching their bot's prompt.
import { AlertTriangle, ChevronDown, FolderOpen } from "lucide-react";
import { useState } from "react";

import { api, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";

/** A visible sentence gap that survives HTML whitespace collapsing. */
const GAP = "  ";

/** One row of `GET /api/bots/:id/skills`, as `server/skills.ts`'s
 * `SkillListing` serialises it.  Declared here rather than imported so the
 * renderer's type graph stops at the HTTP boundary. */
export interface SkillListingRow {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  sha256: string;
  importedAt: string;
  license?: string;
  compatibility?: string;
  warnings: string[];
  skippedFiles: string[];
}

export const SKILLS_PANEL_TITLE = "Skills";

export const SKILLS_PANEL_DESCRIPTION =
  `Reference material this bot reads when a task matches.${GAP}` +
  `An imported skill starts disabled and reaches nothing until you read it and turn it on.`;

export const SKILLS_EMPTY_COPY =
  `No skills imported yet.${GAP}` +
  `Import a skill folder from this computer — its own folder, the one holding SKILL.md.${GAP}` +
  `Only markdown is imported; scripts are left where they are and listed for you.`;

export const IMPORT_BUTTON_LABEL = "Import Skill Folder…";
export const OPEN_SKILL_LABEL = "Open SKILL.md";
export const WARNINGS_HEADING = "Before you enable this";

/** A bot on the Computer engine runs its turn on box.ascii.dev, not on this
 * machine, so it has no workspace for a skill to live in.  Saying so here
 * is cheaper than letting someone import a skill that can never load. */
export function skillsEngineNote(driverKind: string | undefined): string | null {
  if (driverKind !== "boxAgent") return null;
  return `This bot runs on the Computer engine, so it has no workspace on this computer.${GAP}Imported skills never reach it.`;
}

/** GET /api/bots/:id/skills also reports `notIndexed`: enabled skills the
 * prompt's index budget left out (still enabled, still usable if the bot is
 * told about them directly — just not self-discoverable). null/empty means
 * everything enabled made the index. */
export function skillsNotIndexedNotice(notIndexed: string[] | undefined): string | null {
  if (!notIndexed || !notIndexed.length) return null;
  const count = notIndexed.length;
  return (
    `${count} enabled skill${count === 1 ? "" : "s"} not indexed — ${notIndexed.join(", ")}.${GAP}` +
    `Still enabled, but there are too many (or they are too long) for this bot to discover on its own.${GAP}` +
    "Disable one you don't need, or ask the bot to read it directly."
  );
}

function importedAtLabel(importedAt: string): string {
  const at = Date.parse(importedAt);
  if (Number.isNaN(at)) return "an unknown date";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

export interface SkillRowView {
  /** Sentence case, per the fleet copy rule — this is status, not a heading. */
  status: string;
  provenance: string;
  actionLabel: string;
  actionDisabled: boolean;
  /** Why the action is disabled, or null when it is available. */
  gateReason: string | null;
  warnings: string[];
  warningsHeading: string | null;
  skippedNote: string | null;
}

/** Everything one row shows, derived in one place so the three states the
 * server can hand us — nothing imported, imported-and-disabled with scan
 * warnings, enabled — are one function's output and not scattered JSX. */
export function skillRowView(skill: SkillListingRow, opened: boolean, busy = false): SkillRowView {
  const gateReason =
    skill.enabled || opened
      ? null
      : `Open the SKILL.md first.${GAP}Enabling is a decision about text you have read.`;
  return {
    status: skill.enabled
      ? "Enabled — this bot lists this skill and reads it when a task matches."
      : "Disabled — nothing in this skill reaches this bot yet.",
    provenance: `Imported from ${skill.source} on ${importedAtLabel(skill.importedAt)}.`,
    actionLabel: busy ? "Working…" : skill.enabled ? "Disable" : "Enable",
    actionDisabled: busy || Boolean(gateReason),
    gateReason,
    warnings: skill.warnings,
    warningsHeading: skill.warnings.length ? WARNINGS_HEADING : null,
    skippedNote: skill.skippedFiles.length
      ? `Not imported: ${skill.skippedFiles.join(", ")}.`
      : null,
  };
}

/** What the panel body shows instead of a list, or null when the list (or
 * the error banner beside it) says enough.
 *
 * "No skills imported yet" must never be the answer to a question BotFleet
 * failed to ask, so a failed load yields to the error banner — and a failed
 * *toggle* must not blank a list that loaded fine, which is why the list
 * wins over an error whenever there is one to show. */
export function skillsPanelPlaceholder(
  skills: SkillListingRow[],
  loading: boolean,
  error: string | null,
): string | null {
  if (loading) return "Loading…";
  if (skills.length) return null;
  if (error) return null;
  return SKILLS_EMPTY_COPY;
}

/** One imported skill: what it is, what the scan found, what it left
 * behind, and the read-then-enable gate. */
export function SkillRow({
  bot,
  skill,
  onChanged,
  onError,
}: {
  bot: Bot;
  skill: SkillListingRow;
  onChanged: (skill: SkillListingRow) => void;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = skillRowView(skill, opened, busy);

  const openSkillMd = async () => {
    if (text !== null) {
      setShowText(!showText);
      return;
    }
    onError("");
    try {
      const result: { text: string } = await api(`/api/bots/${bot.id}/skills/${skill.name}`);
      setText(result.text);
      setShowText(true);
      setOpened(true);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = async () => {
    setBusy(true);
    onError("");
    try {
      const result: { skill: SkillListingRow } = await api(`/api/bots/${bot.id}/skills/${skill.name}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      onChanged(result.skill);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-hairline/40 px-3 py-2.5 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[12.5px] text-ink" title={skill.name}>
            {skill.name}
          </div>
          <div className="mt-0.5 text-[12px] text-ink-secondary">{skill.description}</div>
        </div>
        <button
          onClick={() => void toggle()}
          disabled={view.actionDisabled}
          title={view.gateReason ?? undefined}
          className="shrink-0 rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
        >
          {view.actionLabel}
        </button>
      </div>

      <div className="mt-1.5 text-[11.5px] text-ink-secondary">{view.status}</div>
      {view.gateReason && <div className="mt-1 text-[11.5px] text-ink-secondary">{view.gateReason}</div>}

      {view.warningsHeading && (
        <div className="mt-2 rounded bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning-dark border border-warning/20">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} /> {view.warningsHeading}
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {view.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {view.skippedNote && <div className="mt-1.5 text-[11.5px] text-ink-secondary">{view.skippedNote}</div>}
      <div className="mt-1 truncate text-[11.5px] text-ink-secondary" title={view.provenance}>
        {view.provenance}
      </div>

      <button
        onClick={() => void openSkillMd()}
        className="mt-2 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink"
      >
        {showText ? "Hide SKILL.md" : OPEN_SKILL_LABEL}
      </button>

      {showText && text !== null && (
        <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Imported skills for one bot.  Fetched on expand, like Memory: settings
 * opens for every bot and most visits never look at skills. */
export function BotSkillsPanel({ bot, driverKind }: { bot: Bot; driverKind?: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillListingRow[]>([]);
  const [notIndexed, setNotIndexed] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  const engineNote = skillsEngineNote(driverKind);
  const placeholder = skillsPanelPlaceholder(skills, loading, error);
  const notIndexedNotice = skillsNotIndexedNotice(notIndexed);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result: { skills: SkillListingRow[]; notIndexed?: string[] } = await api(`/api/bots/${bot.id}/skills`);
      setSkills(result.skills);
      setNotIndexed(result.notIndexed ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const importFolder = async () => {
    const folder = await window.ogb?.pickFolder?.(undefined, "Choose a skill folder");
    if (!folder) return;
    setImporting(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/skills`, { method: "POST", body: JSON.stringify({ folder }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">{SKILLS_PANEL_TITLE}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">{SKILLS_PANEL_DESCRIPTION}</div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3">
          {engineNote && <div className="mb-2 text-[12px] text-ink-secondary">{engineNote}</div>}

          {notIndexedNotice && (
            <div className="mb-2 flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1.5 text-[11px] leading-relaxed text-warning-dark border border-warning/20">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{notIndexedNotice}</span>
            </div>
          )}

          {placeholder && <div className="text-[13px] text-ink-secondary">{placeholder}</div>}

          {skills.length > 0 && (
            <div className={cn("overflow-hidden rounded-lg border border-hairline/40", placeholder && "mt-2")}>
              {skills.map((skill) => (
                <SkillRow
                  key={skill.name}
                  bot={bot}
                  skill={skill}
                  onChanged={(next) =>
                    setSkills((current) => current.map((entry) => (entry.name === next.name ? next : entry)))
                  }
                  onError={(message) => setError(message || null)}
                />
              ))}
            </div>
          )}

          {/* beside the list, never instead of it: a failed toggle must not
              blank the skills the person came here to read */}
          {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}

          {canPick && (
            <button
              onClick={() => void importFolder()}
              disabled={importing}
              className="mt-3 flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              <FolderOpen size={14} /> {importing ? "Importing…" : IMPORT_BUTTON_LABEL}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
