import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OPEN = new Set(["open", "in_progress"]);
const REPO = "Simple-With-Us/BotFleet";
const plain = (value) => String(value ?? "").replace(/\b[a-z][a-z0-9+.-]*:\S+/gi, "[link]").replace(/[\r\n]+/g, " ");
const normalized = (value) => plain(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const summary = (row) => ({ id: row.id, title: plain(row.title), status: row.status, sourceKind: row.source_kind, owner: row.addressed_by || row.reported_by || null });

/** Read-only candidates, never writeback commands or inferred deployment proof. */
export function auditEffortBoard({ board, issues, mergedPullRequests, deployments = [] }) {
  if (![board, issues, mergedPullRequests, deployments].every(Array.isArray)) throw new Error("Expected array snapshots");
  const ids = new Set();
  for (const row of board) {
    if (!row?.id || ids.has(row.id) || row.app !== "botfleet") throw new Error("Board snapshot contains missing, duplicate, or foreign IDs");
    ids.add(row.id);
  }
  const merged = new Map(mergedPullRequests.filter((pr) => pr.mergedAt && pr.mergeCommit?.oid).map((pr) => [pr.number, pr]));
  const roots = board.filter((row) => row.source_kind !== "effort-row");
  const findings = [];
  const links = [];
  for (const row of board) {
    const text = `${row.title ?? ""}\n${row.description ?? ""}\n${row.resolution ?? ""}`;
    const issueLinks = issues.filter((issue) => String(issue.body ?? "").includes(row.id));
    // Exact root ID references are stronger than title similarity.  Only
    // report title candidates; a matching title never authorizes mutation.
    const candidates = row.source_kind === "effort-row" ? roots.filter((root) => {
      const rootTitle = normalized(root.title);
      return text.includes(root.id) || (rootTitle.length >= 32 && normalized(row.title).includes(rootTitle));
    }) : [];
    if (candidates.length) {
      links.push({ derivativeId: row.id, candidateRootIds: candidates.map((root) => root.id), confidence: candidates.some((root) => text.includes(root.id)) ? "explicit-id" : "title-candidate" });
      if (OPEN.has(row.status)) findings.push({ kind: "derivative-row", ...summary(row), candidates: candidates.map(summary) });
    }
    if (!OPEN.has(row.status) && row.status !== "deployed") continue;
    if (OPEN.has(row.status) && /\b(COMPLETED|DEPLOYED|MERGED)\b/i.test(row.title ?? "")) {
      findings.push({ kind: "terminal-text-open-status", ...summary(row) });
    }
    if (row.source_kind !== "effort-row" && !issueLinks.length && !String(row.external_uid ?? "").startsWith(`issue-${REPO}-`)) {
      findings.push({ kind: "missing-canonical-issue-link", ...summary(row) });
    }
    const prNumbers = [...text.matchAll(/https?:\/\/github\.com\/(?:jaywedgeworth22|Simple-With-Us)\/BotFleet\/pull\/(\d+)/gi)].map((match) => Number(match[1]));
    for (const list of text.matchAll(/\bPRs?\s*(#\d+(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*[&/]\s*)#\d+|\s*[-–—]\s*#?\d+)*)/gi)) {
      for (const reference of list[1].matchAll(/#(\d+)(?:\s*[-–—]\s*#?(\d+))?/g)) {
        const first = Number(reference[1]);
        if (reference[2] === undefined) {
          prNumbers.push(first);
          continue;
        }
        const last = Number(reference[2]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) continue;
        // Bound work by the supplied snapshot, never by an untrusted range.
        prNumbers.push(...[...merged.keys()].filter((number) => number >= first && number <= last).sort((a, b) => a - b));
      }
    }
    const references = [...new Set(prNumbers)].flatMap((number) => {
      const pr = merged.get(number);
      return pr ? [{ number, sha: pr.mergeCommit.oid, mergedAt: pr.mergedAt }] : [];
    });
    if (references.length && OPEN.has(row.status)) findings.push({ kind: "merged-reference-needs-scope-review", ...summary(row), references });
    if (row.status === "deployed" && !deployments.some((proof) => proof.boardId === row.id && proof.surface && proof.observedAt && proof.commit && proof.receipt)) {
      findings.push({ kind: "deployed-without-surface-receipt", ...summary(row) });
    }
  }
  return {
    mode: "audit-only",
    snapshot: { rows: board.length, open: board.filter((row) => OPEN.has(row.status)).length, roots: roots.length, issues: issues.length, mergedPullRequests: merged.size },
    warning: "Candidates require scope and current-state review.  A merged PR reference is not proof that it fixed the row or reached a device.  Use board list --limit 2000, not the default 60-row page.",
    findings,
    links,
  };
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const [boardPath, issuePath, prPath, deploymentsPath] = process.argv.slice(2);
  if (!boardPath || !issuePath || !prPath) throw new Error("Usage: node scripts/audit-effort-board.mjs BOARD.json ISSUES.json MERGED_PRS.json [DEPLOYMENTS.json]");
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  console.log(JSON.stringify(auditEffortBoard({ board: read(boardPath), issues: read(issuePath), mergedPullRequests: read(prPath), deployments: deploymentsPath ? read(deploymentsPath) : [] }), null, 2));
}
