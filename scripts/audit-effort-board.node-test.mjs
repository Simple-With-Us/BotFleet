import assert from "node:assert/strict";
import test from "node:test";
import { auditEffortBoard } from "./audit-effort-board.mjs";

test("links derivative candidates without promoting PR references to completion or deployment", () => {
  const root = { id: "root", app: "botfleet", source_kind: "agent-report", title: "Recover credentials for standalone custom engines", status: "in_progress", addressed_by: "CLAUDE", description: "Introduced by PR #10" };
  const derivative = { id: "derivative", app: "botfleet", source_kind: "effort-row", title: "CODEX — COMPLETED — Recover credentials for standalone custom engines", status: "in_progress" };
  const input = { board: [root, derivative], issues: [{ number: 9, body: "Canonical board item root" }], mergedPullRequests: [{ number: 10, mergedAt: "2026-09-12", mergeCommit: { oid: "a".repeat(40) } }] };
  const before = structuredClone(input);
  const report = auditEffortBoard(input);
  assert.equal(report.mode, "audit-only");
  assert.equal(report.snapshot.open, 2);
  assert.deepEqual(report.links[0].candidateRootIds, ["root"]);
  assert.ok(report.findings.some((finding) => finding.kind === "terminal-text-open-status"));
  assert.ok(report.findings.some((finding) => finding.kind === "merged-reference-needs-scope-review" && finding.owner === "CLAUDE"));
  assert.deepEqual(input, before);
});

test("deployment needs a surface receipt; descriptions and merge hashes are insufficient", () => {
  const board = [{ id: "a", app: "botfleet", source_kind: "agent-report", title: "Deployed PR #10", status: "deployed" }];
  const base = { board, issues: [], mergedPullRequests: [] };
  assert.ok(auditEffortBoard(base).findings.some((finding) => finding.kind === "deployed-without-surface-receipt"));
  assert.ok(!auditEffortBoard({ ...base, deployments: [{ boardId: "a", surface: "Mac", observedAt: "2026-09-12", commit: "abc", receipt: "Verified runtime identity" }] }).findings.some((finding) => finding.kind === "deployed-without-surface-receipt"));
});

test("rejects invalid snapshots and does not copy private URLs into the report", () => {
  const row = { id: "a", app: "botfleet", source_kind: "agent-report", title: "Check https://host.invalid/capability/secret", status: "open" };
  const base = { board: [row], issues: [], mergedPullRequests: [] };
  assert.ok(!JSON.stringify(auditEffortBoard(base)).includes("capability/secret"));
  for (const scheme of ["HTTPS", "HtTpS", "HTTP", "wss", "ssh", "file", "botfleet", "custom+app-v2"]) {
    assert.ok(!JSON.stringify(auditEffortBoard({ ...base, board: [{ ...row, title: `Check ${scheme}://host.invalid/capability/secret` }] })).includes("capability/secret"));
  }
  for (const uri of ["mailto:private@example.invalid", "data:text/plain,secret"]) {
    const report = JSON.stringify(auditEffortBoard({ ...base, board: [{ ...row, title: `Check ${uri}` }] }));
    assert.ok(!report.includes(uri));
    assert.ok(report.includes("Check [link]"));
  }
  assert.throws(() => auditEffortBoard({ ...base, board: [row, row] }), /duplicate/);
  assert.throws(() => auditEffortBoard({ ...base, board: [{ ...row, app: "another-app" }] }), /foreign/);
});

test("recognizes PR lists without treating later issue numbers or foreign links as PR evidence", () => {
  const numbers = [314, 316, 324, 332, 339, 47, 49, 90, 121, 9999998, 99, 100];
  const report = auditEffortBoard({
    board: [{ id: "a", app: "botfleet", source_kind: "agent-report", status: "open", title: "Merged PRs #314, #316, and #324; PRs #332 and #339; PRs #46/#47; PRs #48 / #49; PRs #87–#92; PR #120-122; PRs #1000—#9999999.  Issue #99 remains.  https://github.com/other/repo/pull/100" }],
    issues: [],
    mergedPullRequests: numbers.map((number) => ({ number, mergedAt: "2026-09-12", mergeCommit: { oid: "a".repeat(40) } })),
  });
  const finding = report.findings.find((row) => row.kind === "merged-reference-needs-scope-review");
  assert.deepEqual(finding.references.map((row) => row.number), [314, 316, 324, 332, 339, 47, 49, 90, 121, 9999998]);
});

test("accepts board issue UIDs from either owner so a pre-move root row is not a false finding", () => {
  const row = { id: "a", app: "botfleet", source_kind: "agent-report", status: "open", title: "Track the fleet owner rename" };
  const base = { issues: [], mergedPullRequests: [] };
  const flagged = (board) => auditEffortBoard({ ...base, board }).findings.filter((finding) => finding.kind === "missing-canonical-issue-link");
  assert.equal(flagged([row]).length, 1);
  for (const owner of ["jaywedgeworth22", "Simple-With-Us"]) {
    assert.equal(flagged([{ ...row, external_uid: `issue-${owner}/BotFleet-da11b074` }]).length, 0, owner);
  }
  assert.equal(flagged([{ ...row, external_uid: "issue-some-other-org/BotFleet-da11b074" }]).length, 1);
});
