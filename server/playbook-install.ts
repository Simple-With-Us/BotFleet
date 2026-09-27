/**
 * Install package-authored playbooks onto a bot that already exists.
 *
 * A bot record has carried `playbooks` since packages existed, the prompt has
 * always rendered it, and the field could never become non-empty for a bot the
 * owner actually owns.  Two facts pinned the provenance: store.ts calls them
 * "Public, package-authored playbooks installed for this bot", and the prompt
 * block installed-playbooks.ts renders is titled `installed_package_playbooks`
 * and holds "reviewed, package-authored" process guidance.  The one writer was
 * the whole-team import (server/index.ts), which can only reach the bots it
 * just created — so re-importing a package to give an existing bot a playbook
 * means creating a second team, and `playbooks` is absent from
 * parseBotProfilePatch's field list, so PATCH /api/bots/:id/profile rejects it.
 * Twelve live bots, every one of them `playbooks: []`, and no product path that
 * could change it: a capability that exists in the data model and in the prompt
 * plumbing and that nothing can reach.
 *
 * So the fix is the one the code's own shape points at — (a), a package the
 * owner installs — made per bot.  This takes the SAME artifact the team
 * library already installs: a `botfleet.package` JSON document or the BotMRR
 * Markdown blueprint, run through the same parseBotPackage, so the key format,
 * the name/summary/trigger/instruction limits and the cross-references are
 * exactly the ones a package install has always enforced.  Deliberately NOT
 * inline authoring and NOT an agent tool: both would put text in the prompt
 * under a heading that promises reviewed, package-authored guidance, and
 * neither is what the surrounding code was built for.
 *
 * The merge is additive by key.  Installing a key that is already there
 * REPLACES it in place — a revised package is an edit, not a duplicate — and a
 * new key appends, so the order the owner installed stays the order they read.
 */
import { isBotPackage, parseBotPackage } from "./bot-package.ts";
import type { JsonValue } from "./schema.ts";
import type { InstalledPlaybook } from "./store.ts";

/** A bot's record is bounded here as well as at the package boundary: the
 *  package schema allows 80 playbooks, and a bot accumulates them across
 *  packages, so the stored list gets the same ceiling. */
export const MAX_INSTALLED_PLAYBOOKS = 80;

/** One package document is capped at 1 MB of UTF-8 (bot-package.ts's own
 *  Markdown guard).  The same ceiling applies to one bot's merged list, so a
 *  bot cannot be grown without limit by installing package after package.  The
 *  prompt-side budget is separate and much smaller: installed-playbooks.ts
 *  renders at most MAX_RENDERED_CHARS and mounts at most MAX_SELECTED. */
export const MAX_INSTALLED_PLAYBOOK_BYTES = 1_000_000;

export type PlaybookInstallResult =
  | { ok: true; playbooks: InstalledPlaybook[]; installed: InstalledPlaybook[] }
  | { ok: false; error: string };

const byteLength = (playbooks: InstalledPlaybook[]) =>
  Buffer.byteLength(JSON.stringify(playbooks), "utf8");

/** The playbooks one package document declares, in package order.  Throws on
 *  anything that is not a complete, valid package — the same messages
 *  /api/teams/import surfaces — so a bad file is rejected here rather than
 *  half-installed. */
export function playbooksFromPackage(document: JsonValue | string): InstalledPlaybook[] {
  if (!isBotPackage(document)) throw new Error("This is not a BotFleet package");
  return (parseBotPackage(document).package.playbooks ?? []).map((playbook) => ({ ...playbook }));
}

export interface PlaybookInstallInput {
  /** A `botfleet.package` JSON document or a BotMRR Markdown blueprint. */
  document: JsonValue | string;
  /** Install only these playbook keys.  Omitted, every playbook in the
   *  package is installed.  A key the package does not declare is an error
   *  rather than a silent no-op: the owner asked for something by name. */
  keys?: string[];
  /** What the bot already has, in install order. */
  existing?: InstalledPlaybook[];
}

/**
 * Resolve an install request into the exact `playbooks` value to store on the
 * bot.  Pure: it reads no store and writes no file, so the route stays a
 * `patchBot` and the merge is unit-testable without a server.
 */
export function resolvePlaybookInstall(input: PlaybookInstallInput): PlaybookInstallResult {
  let declared: InstalledPlaybook[];
  try {
    declared = playbooksFromPackage(input.document);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "This is not a bot package" };
  }

  let wanted: InstalledPlaybook[];
  if (input.keys === undefined) {
    wanted = declared;
  } else {
    if (!Array.isArray(input.keys) || input.keys.some((key) => typeof key !== "string" || !key.trim())) {
      return { ok: false, error: "keys must be a list of playbook keys" };
    }
    if (input.keys.length === 0) return { ok: false, error: "keys must name at least one playbook" };
    const byKey = new Map(declared.map((playbook) => [playbook.key, playbook]));
    const missing = input.keys.filter((key) => !byKey.has(key));
    if (missing.length) {
      return { ok: false, error: `This package has no playbook: ${missing[0]}` };
    }
    // Package order, not request order, so a two-key install lands in the
    // order the package reads.
    const asked = new Set(input.keys);
    wanted = declared.filter((playbook) => asked.has(playbook.key)).map((playbook) => ({ ...playbook }));
  }

  if (wanted.length === 0) {
    return { ok: false, error: "This package declares no playbooks to install" };
  }

  const existing = input.existing ?? [];
  const merged = existing.map((playbook) => ({ ...playbook }));
  for (const playbook of wanted) {
    const at = merged.findIndex((candidate) => candidate.key === playbook.key);
    if (at >= 0) merged[at] = { ...playbook };
    else merged.push({ ...playbook });
  }

  if (merged.length > MAX_INSTALLED_PLAYBOOKS) {
    return {
      ok: false,
      error: `A bot may hold at most ${MAX_INSTALLED_PLAYBOOKS} playbooks, this would be ${merged.length}`,
    };
  }
  if (byteLength(merged) > MAX_INSTALLED_PLAYBOOK_BYTES) {
    return { ok: false, error: "The installed playbooks are too large" };
  }

  return { ok: true, playbooks: merged, installed: wanted };
}
