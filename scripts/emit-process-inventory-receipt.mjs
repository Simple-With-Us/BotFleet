// Emit the `process-inventory` receipt for the decommission evidence bundle (BF-2514).
//
// The bundle's `process-inventory` receipt names four checks -- `processes`,
// `launchd`, `listeners` and `inventory-updated` -- and one statement,
// `macHarness: "absent"`.  Nothing in the tree produced them, so the receipt
// could only ever be asserted by a person.
//
// The measurement already exists.  `scripts/check-post-reboot-node.mjs --json`
// inspects the Mac's processes, its launchd jobs and its listeners and prints
// a verdict.  This script is the other half:  it reads a saved verdict, and
// the rows the operator captured out of the Mac's process inventory, and
// emits the receipt the bundle validates.
//
// The exit codes are read out of the files the checks name, never asserted.
// A receipt that says a check passed when its artifact says it failed is worse
// than no receipt at all:  the bundle validator accepts a check whose exit
// code is zero and whose artifact hashes correctly, so a hardcoded zero would
// turn a Mac that still runs the harness into evidence that it does not.
//
// The verdict's summary is checked against the verdict's own details.  The
// reboot check computes `ok` and `failures` out of its details, so a verdict
// whose summary says one thing and whose details say another did not come
// from the check, and it is refused rather than read.  A listener's stored
// `isNode` flag is recomputed from its command for the same reason.
//
// A verdict has to be an observation of a Mac.  Off macOS the reboot check
// skips every launchd probe and reports no loaded agent, which reads exactly
// like a retired harness.  So a verdict that does not say it was taken on
// `darwin`, that skipped a probe, or that predates those fields is refused.
// On macOS the same thing happens one level up:  the probes ask the GUI domain
// of the user who ran the check, and launchd answers "not found" for every
// label when that domain does not exist, as it does for root and for an SSH
// session with nobody logged in at the console.  So a verdict whose
// `launchDomain` was not observed, or that was taken as root, is refused too.
//
// The files the receipt cites are read through the bundle's own reader, once.
// That reader refuses a link, a file with more than one name, and anything
// that is not owner-only, so the producer cannot exit 0 on a file the bundle
// will refuse, and the bytes that are hashed are the bytes that were judged.
//
// `macHarness: "absent"` is the only value the bundle accepts, and it is true
// only when all three harness checks are clean.  When one of them is not, no
// honest receipt exists:  this script writes nothing, removes the receipt an
// earlier run left in the capture directory, and exits 1.  The inventory check
// is different:  the harness can be gone while the inventory still describes
// it, so that receipt is written with a failing `inventory-updated` code, and
// the bundle refuses it.
//
// What this script cannot establish:  that the verdict was taken on the Mac
// the packet names, that it was taken after the retirement, or that the
// captured rows are every row the inventory holds.  It reads saved files.
//
// Usage:
//   node scripts/emit-process-inventory-receipt.mjs --capture <capture-dir> \
//     --request <bundle-request.json> --verdict <post-reboot-verdict.json> \
//     --inventory-rows <inventory-rows.md> \
//     --provenance-record <file-in-capture-dir> \
//     --provenance-source <https-url> --provenance-by <who>
import { chmodSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateBundleRequest } from "./archive-node-store.mjs";
import { BOTFLEET_AGENTS, evaluatePostReboot, isNodeListenerCommand } from "./check-post-reboot-node.mjs";
import { createEvidenceReader, evidenceHash, MAX_EVIDENCE_FILE_BYTES, parseEvidenceReceipt, REQUIRED_CHECKS } from "./decommission-evidence-bundle.mjs";
import { assertPrivateCaptureDir } from "./emit-replay-receipt.mjs";

export const PROCESS_INVENTORY_RECEIPT_VERSION = 1;
export const PROCESS_INVENTORY_RECEIPT_FILE = "process-inventory.receipt.json";

/**
 * The two names the Mac's process inventory files the harness under:  the
 * launchd label and the wrapper the job runs.  A captured row is one of the
 * harness's rows when its first cell carries either name.
 */
export const INVENTORY_NAMES = ["app.botfleet.server", "botfleet-server-start.sh"];

const boundedText = z.string().max(65_536);

/**
 * The verdict's shape, as far as the receipt reads it.
 *
 * The verdict is the reboot check's own `--json` output and it is parsed at
 * the boundary rather than narrowed as it is used.  `platform`,
 * `launchDomain` and `launchProbes` are required:  a verdict saved before the
 * check printed them cannot say where it was taken or which launchd domain it
 * asked, so it is refused here, where the reason can be said, instead of being
 * read as a clean Mac.
 */
const PostRebootVerdictSchema = z.looseObject({
  ok: z.boolean(),
  failures: z.array(boundedText).max(16),
  platform: z.string().min(1).max(64),
  launchDomain: z.looseObject({
    uid: z.number().int().min(0).nullable(),
    target: z.string().min(1).max(64).nullable(),
    observed: z.boolean(),
    skipped: z.boolean(),
  }),
  launchProbes: z.array(z.looseObject({
    label: z.string().min(1).max(256),
    loaded: z.boolean(),
    running: z.boolean(),
    skipped: z.boolean(),
  })).max(64),
  details: z.looseObject({
    processes: z.array(z.looseObject({
      pid: z.string().max(32),
      command: boundedText,
      identity: z.string().max(64).optional(),
    })).max(4096),
    launchAgents: z.array(z.looseObject({ label: z.string().min(1).max(256) })).max(64),
    portListeners: z.array(z.looseObject({
      port: z.number().int().min(1).max(65_535),
      pid: z.string().max(32),
      command: z.string().max(4096),
      isNode: z.boolean(),
    })).max(4096),
    gitFiles: z.array(z.string().max(4096)).max(65_536),
    probeErrors: z.array(boundedText).max(64),
  }),
});

/** The provenance source has to be an https URL, because the receipt says where the run came from. */
const ProvenanceSourceSchema = z.string().startsWith("https://");

/**
 * The provenance instant is the bundle's own kind of instant.  The captured
 * rows are judged against it, so it is parsed before anything is read.
 */
const ProvenanceInstantSchema = z.iso.datetime({ offset: true });

/**
 * Say why the bundle's reader refused a file, in words an operator can act on.
 *
 * The reader answers with a short code.  A link and a file that is not
 * owner-only share one code, so the entry is looked at again to tell them
 * apart;  that second look only chooses the wording, and the refusal stands
 * either way.
 */
function readerRefusal(error, physicalPath) {
  switch (error?.message) {
    case "malformed-schema":
      return "has a path the bundle's reader does not accept, which takes letters, digits, dots, dashes, underscores and slashes only";
    case "evidence-path-not-private": {
      let isLink = false;
      try {
        isLink = lstatSync(physicalPath).isSymbolicLink();
      } catch {
        /* the entry is gone;  the general wording below still holds */
      }
      return isLink
        ? "is a symbolic link, and the bundle reads plain files only"
        : "is not owner-only, or a folder above it is not:  the bundle reads files of mode 0600, in folders of mode 0700, that the user running this owns";
    }
    case "evidence-path-link":
      return "is reached through a link";
    case "evidence-not-single-link-file":
      return "is not a plain file with a single name:  it is hard-linked, or it is not a file";
    case "evidence-file-too-large":
      return `is over the bundle's file limit of ${MAX_EVIDENCE_FILE_BYTES} bytes`;
    case "evidence-file-changed":
    case "bundle-directory-changed":
      return "changed while it was being read";
    default:
      return "could not be read";
  }
}

/** Open the bundle's reader on the capture directory, which it requires to be private and the user's own. */
function openCaptureReader(capture) {
  try {
    return createEvidenceReader(capture);
  } catch {
    throw new Error(`the capture directory is not a private directory the user running this owns: ${capture}`);
  }
}

/**
 * Read a file the receipt is going to cite, through the bundle's own reader.
 *
 * The bundle reads every cited file with `createEvidenceReader`, which
 * refuses a symbolic link, a file with more than one name, anything that is
 * not owner-only and anything over its size limit, and reads the bytes from
 * one open file.  Reading the same way here means the producer never earns an
 * exit code from a file the bundle will later refuse, never follows a link
 * out of the capture directory, and hashes exactly the bytes it judged.
 *
 * Returns the bytes and the hash reference the receipt cites them by.
 */
function readCited(reader, filePath, what) {
  const absolute = resolve(filePath);
  let physical;
  try {
    // The folder is resolved and the name is not:  a folder that links out of
    // the capture directory is caught by the containment test below, and a
    // file that is itself a link is left for the reader to refuse.
    physical = join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    throw new Error(`the ${what} could not be read: ${filePath}`);
  }
  const path = relative(reader.root, physical).split(sep).join("/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error(`the ${what} is not inside the capture directory: ${filePath}`);
  }
  let bytes;
  try {
    bytes = reader.read(path);
  } catch (error) {
    throw new Error(`the ${what} ${readerRefusal(error, physical)}: ${filePath}`);
  }
  return { bytes, reference: { path, sha256: evidenceHash(bytes) } };
}

/**
 * Refuse a verdict that is not an observation of a Mac's launchd.
 *
 * The saved verdict is the only thing that says where it was taken.  Off
 * macOS the real probe answers `skipped` with `loaded: false`, so a verdict
 * captured on the server would otherwise earn `macHarness: "absent"`.
 *
 * On macOS the probes ask `gui/<uid>/<label>`, and launchd answers "not
 * found" for every label when `gui/<uid>` itself does not exist.  That is
 * the case for root, whose GUI domain is not the owner's, and for a session
 * with nobody logged in at the console.  So the domain has to have been
 * observed, and the check must not have run as root.
 */
function assertObservedOnMac(verdict) {
  if (verdict.platform !== "darwin") {
    throw new Error(`the post-reboot verdict was taken on "${verdict.platform}" and not on macOS, so its launchd answers are not observations`);
  }
  const domain = verdict.launchDomain;
  if (domain.skipped || domain.uid === null || domain.target === null) {
    throw new Error("the post-reboot verdict did not ask launchd for the user's GUI domain, so its launchd answers are not observations");
  }
  if (domain.uid === 0) {
    throw new Error("the post-reboot verdict was taken as root, and the launch agents live in the logged-in owner's GUI domain, not root's:  run the check as the owner, without sudo");
  }
  if (domain.target !== `gui/${domain.uid}`) {
    throw new Error(`the post-reboot verdict says it asked the launchd domain "${domain.target}", which is not the GUI domain of the user who ran it`);
  }
  if (!domain.observed) {
    throw new Error(`the post-reboot verdict could not find the launchd domain "${domain.target}", so "not loaded" only means the domain was missing:  run the check as the owner while the owner is logged in at the Mac's console`);
  }
  const probes = new Map();
  for (const probe of verdict.launchProbes) {
    if (probes.has(probe.label)) {
      throw new Error(`the post-reboot verdict probes the launch agent "${probe.label}" more than once`);
    }
    probes.set(probe.label, probe);
  }
  for (const label of BOTFLEET_AGENTS) {
    if (!probes.has(label)) {
      throw new Error(`the post-reboot verdict carries no launchd probe for "${label}"`);
    }
  }
  for (const probe of verdict.launchProbes) {
    if (probe.skipped) {
      throw new Error(`the post-reboot verdict skipped the launchd probe for "${probe.label}"`);
    }
  }
}

/**
 * Refuse a verdict that contradicts itself.
 *
 * The reboot check derives its loaded agents from its probes, a listener's
 * `isNode` flag from the listener's command, and `ok` and `failures` from its
 * details.  A verdict in which any of those pairs disagree is not a verdict
 * the check wrote.
 */
function assertSelfConsistent(verdict) {
  const { details } = verdict;

  const active = new Set(verdict.launchProbes.filter((probe) => probe.loaded || probe.running).map((probe) => probe.label));
  const reported = new Set();
  for (const agent of details.launchAgents) {
    if (reported.has(agent.label)) {
      throw new Error(`the post-reboot verdict lists the launch agent "${agent.label}" more than once`);
    }
    reported.add(agent.label);
  }
  for (const label of new Set([...active, ...reported])) {
    if (active.has(label) !== reported.has(label)) {
      throw new Error(`the post-reboot verdict's launchd probes and its loaded launch agents disagree about "${label}"`);
    }
  }

  for (const listener of details.portListeners) {
    if (listener.isNode !== isNodeListenerCommand(listener.command)) {
      throw new Error(`the post-reboot verdict flags the listener on port ${listener.port} as ${listener.isNode ? "Node" : "not Node"}, which its own command contradicts`);
    }
  }

  const recomputed = evaluatePostReboot(details);
  if (recomputed.ok !== verdict.ok) {
    throw new Error(`the post-reboot verdict says ok is ${verdict.ok} and its own details recompute to ${recomputed.ok}`);
  }
  if (JSON.stringify(recomputed.failures) !== JSON.stringify(verdict.failures)) {
    throw new Error("the post-reboot verdict's failures are not the failures its own details recompute to");
  }
}

/**
 * Parse a saved verdict and refuse one that cannot be judged.
 *
 * A verdict that is malformed, was not taken on a Mac or contradicts itself is
 * a producer failure rather than a check failure:  no honest exit code can be
 * derived from it, and a receipt built on it would be a guess.
 */
export function parsePostRebootVerdict(bytes, verdictPath = "the verdict") {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`the post-reboot verdict could not be read as JSON: ${verdictPath}`);
  }
  const result = PostRebootVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "verdict"}: ${issue.message}`)
      .join("; ");
    throw new Error(`the post-reboot verdict does not match the contract: ${issues}`);
  }
  assertObservedOnMac(result.data);
  assertSelfConsistent(result.data);
  return result.data;
}

/**
 * Read a saved verdict from disk, the way the bundle would read it.  See
 * `readCited` and `parsePostRebootVerdict`.
 */
export function readPostRebootVerdict(verdictPath) {
  const absolute = resolve(verdictPath);
  let reader;
  try {
    reader = createEvidenceReader(dirname(absolute));
  } catch {
    throw new Error(`the post-reboot verdict could not be read, because its folder is missing or is not private to the user running this: ${verdictPath}`);
  }
  return parsePostRebootVerdict(readCited(reader, absolute, "post-reboot verdict").bytes, verdictPath);
}

/**
 * The exit codes the three harness checks earn, read out of the verdict.
 *
 * A probe that failed observed nothing, so a probe error fails all three.
 * `details.gitFiles` is not read:  it belongs to the tree check, and before
 * the Phase 6 deletion a `--check-git` verdict always lists files.
 *
 * Every condition is restated here rather than assumed from the boundary, so
 * a verdict that never went through `parsePostRebootVerdict` still cannot
 * earn a zero it did not observe.
 */
export function harnessChecks(verdict) {
  const details = verdict?.details ?? {};
  const lists = [details.processes, details.launchAgents, details.portListeners, details.probeErrors];
  const reasons = [];
  if (!lists.every(Array.isArray)) {
    return { processes: 1, launchd: 1, listeners: 1, reasons: ["the verdict carries no inspection details"] };
  }
  const probed = details.probeErrors.length === 0;
  if (!probed) reasons.push(`${details.probeErrors.length} inspection probe(s) failed, so nothing was observed`);

  if (details.processes.length > 0) reasons.push(`processes: ${details.processes.length} BotFleet process(es) still present`);

  const probes = Array.isArray(verdict.launchProbes) ? verdict.launchProbes : [];
  const domain = verdict.launchDomain;
  const domainObserved = domain?.observed === true && domain.skipped === false
    && Number.isInteger(domain.uid) && domain.uid > 0 && domain.target === `gui/${domain.uid}`;
  const launchdObserved = verdict.platform === "darwin" && domainObserved && BOTFLEET_AGENTS.every((label) => {
    const answers = probes.filter((probe) => probe?.label === label);
    return answers.length === 1 && answers[0].skipped === false && answers[0].loaded === false && answers[0].running === false;
  });
  const launchdClean = details.launchAgents.length === 0 && launchdObserved;
  if (!launchdClean) {
    const labels = details.launchAgents.map((agent) => String(agent?.label ?? "an unnamed agent"));
    reasons.push(labels.length > 0 ? `launchd: still loaded: ${labels.join(", ")}` : "launchd: the agents were not all observed unloaded on macOS");
  }

  const nodeListeners = details.portListeners.filter((listener) => listener?.isNode === true || isNodeListenerCommand(listener?.command));
  if (nodeListeners.length > 0) {
    reasons.push(`listeners: ${nodeListeners.map((listener) => `port ${listener.port}`).join(", ")} still held by a Node, Electron or BotFleet command`);
  }

  return {
    processes: probed && details.processes.length === 0 ? 0 : 1,
    launchd: probed && launchdClean ? 0 : 1,
    listeners: probed && nodeListeners.length === 0 ? 0 : 1,
    reasons,
  };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const RETIRED_MARKER = /^retired\s+(?:on\s+)?(?:(\d{4})-(\d{2})-(\d{2})|(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4}))(?![\d-])/i;

/** A calendar date as `YYYY-MM-DD`, or null when the parts do not name a real day. */
function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a cell opens with the retired marker, and the date it carries.
 *
 * The marker is the word `Retired` followed by a date, with or without bold:
 * `**Retired 2026-11-20**` or `Retired Nov 20, 2026`.  It has to open the
 * cell.  A cell that only mentions a retirement -- "retirement plan",
 * "to be retired" -- does not open with it, and today's live rows carry
 * exactly that wording.
 *
 * Returns null when the cell does not open with the marker, `{ date: null }`
 * when it does and the date is not a real day, and `{ date }` otherwise.
 */
export function retiredMarker(cell) {
  const match = RETIRED_MARKER.exec(String(cell).replaceAll("*", "").trim());
  if (!match) return null;
  if (match[1]) return { date: calendarDate(Number(match[1]), Number(match[2]), Number(match[3])) };
  // A month is its full name or a prefix of it at least three letters long:
  // `Nov`, `Sept` and `November` all name the same month.
  const month = MONTHS.findIndex((name) => name.startsWith(match[4].toLowerCase()));
  if (month === -1) return { date: null };
  return { date: calendarDate(Number(match[6]), month + 1, Number(match[5])) };
}

const LIVE_WORDING = /\b(running|loaded|always[- ]on)\b/gi;
const PAST_TENSE_LEAD = /\b(?:was|were|had been|formerly|previously|no longer|not|never)\s+(?:(?:a|an|the)\s+)?$/i;

/**
 * The live wording a row still carries.
 *
 * A retired row may say what the job was, and may not say what it is.  So
 * `running`, `loaded` and `always-on` are accepted only in the past-tense
 * form -- directly after `was`, `were`, `had been`, `formerly`, `previously`,
 * `no longer`, `not` or `never`, with an article allowed between -- and every
 * other use is reported.  Each word needs its own lead:  "was loaded and
 * running" still reports `running`.  `unloaded` is a different word and is
 * not matched.
 */
export function liveWording(text) {
  const plain = String(text).replace(/[*_`]/g, "");
  const found = [];
  for (const match of plain.matchAll(LIVE_WORDING)) {
    if (!PAST_TENSE_LEAD.test(plain.slice(Math.max(0, match.index - 48), match.index))) found.push(match[1].toLowerCase());
  }
  return [...new Set(found)];
}

/** The cells of a Markdown table row, or null when the line is not one. */
function tableCells(line) {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

/**
 * An instant's UTC date, as `YYYY-MM-DD`.
 *
 * This is the latest date a retired row may carry.  The inventory's dates are
 * on the owner's clock, which is behind UTC, so the date on that clock is the
 * instant's UTC date or the day before it, and never later.  No slack is
 * added on top:  a row dated after the capture's UTC date is dated in the
 * future wherever it was written.
 */
function utcDate(instant) {
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * Judge the rows the operator captured out of the Mac's process inventory.
 *
 * The inventory is free-form Markdown outside this repository, and it names
 * the harness in more than one table.  So the judgment is about the captured
 * rows and nothing else:
 *
 * - every non-blank line is a table row;
 * - a row whose first cell carries one of `INVENTORY_NAMES` is a harness row,
 *   and each name has at least one;
 * - a harness row has a cell after the name that opens with the retired
 *   marker and a real date, no later than the UTC date of `capturedAt`;
 * - a harness row carries no live wording.
 *
 * A row whose first cell names neither is another job's row and is not
 * judged:  the watcher's row, for one, says it skips the harness.  It is not
 * passed over in silence either.  When such a row mentions one of the names
 * in a later cell it is listed in `notices`, which fail nothing and tell the
 * operator which captured rows still talk about the harness and were not
 * checked.
 *
 * The reasons and the notices name line numbers and matched words only, never
 * the row's text, because the inventory is private.
 */
export function judgeInventoryRows(text, { capturedAt } = {}) {
  const reasons = [];
  const notices = [];
  const named = new Map(INVENTORY_NAMES.map((name) => [name, 0]));
  if (capturedAt !== undefined && Number.isNaN(Date.parse(capturedAt))) {
    throw new Error("the capture instant the inventory rows are judged against is not a date and time");
  }
  const latest = capturedAt === undefined ? null : utcDate(capturedAt);
  let rows = 0;

  String(text).split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `line ${index + 1}`;
    const cells = tableCells(line);
    if (!cells) {
      reasons.push(`${where} is not a table row`);
      return;
    }
    const names = INVENTORY_NAMES.filter((name) => cells[0].includes(name));
    if (names.length === 0) {
      const mentioned = INVENTORY_NAMES.filter((name) => cells.slice(1).some((cell) => cell.includes(name)));
      if (mentioned.length > 0) {
        notices.push(`${where} mentions ${mentioned.join(" and ")} outside its first cell, so it was not judged as a harness row`);
      }
      return;
    }
    rows += 1;
    for (const name of names) named.set(name, named.get(name) + 1);

    const marker = cells.slice(1).map(retiredMarker).find((found) => found !== null);
    if (!marker) {
      reasons.push(`${where} names ${names.join(" and ")} and no cell after the name opens with "Retired" and a date`);
    } else if (marker.date === null) {
      reasons.push(`${where} opens a cell with "Retired" and a date that is not a real day`);
    } else if (latest !== null && marker.date > latest) {
      reasons.push(`${where} is retired on ${marker.date}, which is after ${latest}, the UTC date this receipt was captured on`);
    }

    const live = liveWording(cells.join(" | "));
    if (live.length > 0) {
      reasons.push(`${where} still says ${live.map((word) => `"${word}"`).join(", ")} without the past-tense form`);
    }
  });

  for (const [name, count] of named) {
    if (count === 0) reasons.push(`no captured row names ${name}`);
  }
  return { ok: reasons.length === 0, reasons, rows, notices };
}

/** Decode the captured rows, refusing bytes that are not text. */
function decodeInventoryRows(bytes, rowsPath) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`the inventory rows are not UTF-8 text: ${rowsPath}`);
  }
}

/** Refuse to write over anything that is not this script's own plain file. */
function assertWritableReceiptPath(receiptPath) {
  let entry;
  try {
    entry = lstatSync(receiptPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error(`the receipt path could not be inspected: ${receiptPath}`);
  }
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error(`the receipt path is not a plain single-link file: ${receiptPath}`);
  }
}

/**
 * Emit the `process-inventory` receipt.
 *
 * The candidate, mode and hosts come from the bundle request the operator
 * prepared, so the receipt is bound to the same candidate as the rest of the
 * packet.  The check names come from the bundle's own `REQUIRED_CHECKS`, so a
 * check the bundle starts to require and this script cannot derive is a
 * refusal rather than a receipt with a hole in it.
 *
 * Returns `{ receipt, macHarness, checks, reasons, notices }`.  `receipt` is
 * null when nothing was written, which is the case whenever the harness is
 * not absent.  `notices` fail nothing:  they name the captured rows that
 * mention the harness and were not judged.
 */
export function emitProcessInventoryReceipt({ captureDir, request, provenance, verdictPath, inventoryRowsPath }) {
  const capture = resolve(captureDir);
  assertPrivateCaptureDir(capture);
  const bundle = validateBundleRequest(request);
  const source = ProvenanceSourceSchema.safeParse(provenance?.source);
  if (!source.success) {
    throw new Error("the provenance source must be an https URL");
  }
  if (!ProvenanceInstantSchema.safeParse(provenance.at).success) {
    throw new Error("the provenance instant must be an ISO 8601 date and time with an offset");
  }

  // One reader for all three files, so each is read once, under the bundle's
  // own rules, and the bytes that are judged are the bytes that are hashed.
  const reader = openCaptureReader(capture);
  const verdictFile = readCited(reader, verdictPath, "post-reboot verdict");
  const verdict = parsePostRebootVerdict(verdictFile.bytes, verdictPath);
  const verdictReference = verdictFile.reference;

  const rowsFile = readCited(reader, inventoryRowsPath, "inventory rows");
  const rowsText = decodeInventoryRows(rowsFile.bytes, inventoryRowsPath);
  const rowsReference = rowsFile.reference;

  const recordReference = readCited(reader, provenance.record, "provenance record").reference;

  const harness = harnessChecks(verdict);
  const inventory = judgeInventoryRows(rowsText, { capturedAt: provenance.at });
  const derived = {
    processes: { exitCode: harness.processes, artifact: verdictReference },
    launchd: { exitCode: harness.launchd, artifact: verdictReference },
    listeners: { exitCode: harness.listeners, artifact: verdictReference },
    "inventory-updated": { exitCode: inventory.ok ? 0 : 1, artifact: rowsReference },
  };
  const checks = REQUIRED_CHECKS["process-inventory"].map((name) => {
    if (!Object.hasOwn(derived, name)) {
      throw new Error(`the bundle requires the check "${name}", which this producer cannot derive`);
    }
    return { name, ...derived[name] };
  });
  const reasons = [...harness.reasons, ...inventory.reasons.map((reason) => `inventory-updated: ${reason}`)];
  const summary = checks.map((check) => ({ name: check.name, exitCode: check.exitCode }));

  const receiptPath = join(capture, PROCESS_INVENTORY_RECEIPT_FILE);
  assertWritableReceiptPath(receiptPath);

  const harnessAbsent = harness.processes === 0 && harness.launchd === 0 && harness.listeners === 0;
  if (!harnessAbsent) {
    // The bundle accepts `macHarness: "absent"` and nothing else, and it is
    // not true here.  Nothing is written, and a receipt an earlier run left
    // behind is removed so the capture directory does not keep a statement
    // the newest verdict contradicts.
    rmSync(receiptPath, { force: true });
    return { receipt: null, macHarness: "present", checks: summary, reasons, notices: inventory.notices };
  }

  const receipt = {
    version: PROCESS_INVENTORY_RECEIPT_VERSION,
    kind: "process-inventory",
    candidate: bundle.candidate,
    mode: bundle.mode,
    hosts: bundle.hosts,
    provenance: {
      by: provenance.by,
      at: provenance.at,
      source: provenance.source,
      record: recordReference,
    },
    data: { checks, macHarness: "absent" },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  try {
    parseEvidenceReceipt("process-inventory", receiptBytes);
  } catch {
    throw new Error("the receipt would not match the bundle's schema, so nothing was written:  check the provenance fields");
  }

  writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
  // `writeFileSync` only applies the mode when it creates the file, so the
  // mode is set again for the case where a receipt was already there.
  chmodSync(receiptPath, 0o600);
  return { receipt, macHarness: "absent", checks: summary, reasons, notices: inventory.notices };
}

/** A flag's value, or undefined when the flag is absent or has no value. */
function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

let isEntry = false;
try {
  // `realpathSync`, not `resolve`:  Node's ESM loader resolves symlinks for
  // `import.meta.url` and leaves `process.argv[1]` as it was typed, so a
  // script invoked through a symlink would otherwise look like an import and
  // quietly do nothing.
  isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* imported */
}

if (isEntry) {
  const args = process.argv.slice(2);
  const fail = (message) => {
    console.error(`emit-process-inventory-receipt refused: ${message}`);
    process.exitCode = 2;
  };
  try {
    const captureDir = flagValue(args, "--capture");
    const requestPath = flagValue(args, "--request");
    const verdictPath = flagValue(args, "--verdict");
    const inventoryRowsPath = flagValue(args, "--inventory-rows");
    const provenanceRecord = flagValue(args, "--provenance-record");
    const provenanceSource = flagValue(args, "--provenance-source");
    const provenanceBy = flagValue(args, "--provenance-by");
    if (!captureDir || !requestPath || !verdictPath || !inventoryRowsPath || !provenanceRecord || !provenanceSource || !provenanceBy) {
      throw new Error("--capture, --request, --verdict, --inventory-rows, --provenance-record, --provenance-source and --provenance-by are required");
    }
    let requestJson;
    try {
      requestJson = JSON.parse(readFileSync(requestPath, "utf8"));
    } catch {
      throw new Error(`the bundle request could not be read as JSON: ${requestPath}`);
    }
    const result = emitProcessInventoryReceipt({
      captureDir,
      request: validateBundleRequest(requestJson),
      verdictPath: resolve(verdictPath),
      inventoryRowsPath: resolve(inventoryRowsPath),
      provenance: {
        by: provenanceBy,
        at: flagValue(args, "--provenance-at") ?? new Date().toISOString(),
        source: provenanceSource,
        record: resolve(provenanceRecord),
      },
    });
    console.log(JSON.stringify({
      emitted: result.receipt ? [PROCESS_INVENTORY_RECEIPT_FILE] : [],
      macHarness: result.macHarness,
      checks: result.checks,
      reasons: result.reasons,
      notices: result.notices,
    }));
    if (result.checks.some((check) => check.exitCode !== 0)) process.exitCode = 1;
  } catch (error) {
    fail(error.message);
  }
}
