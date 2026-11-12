// Offline consistency checks, not authentication of a runner or proof that
// an observation, command result, elapsed run or owner assertion is true.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { HOST_ID_PATTERN } from "../shared/placement.ts";
import { checkPlacementEvidenceArtifacts } from "./check-placement-evidence.mjs";

export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_BUNDLE_BYTES = 16 * MAX_EVIDENCE_FILE_BYTES;
export const MAX_EVIDENCE_FILES = 128;
export const REQUIRED_RECEIPTS = [
  "placement", "import", "replay", "rollback", "signed-release", "linux-retention",
  "process-inventory", "control-disposition", "change-plan", "server-writer-soak",
  "no-mac-node-soak", "daily-driver", "owner-acceptance",
];
export const REQUIRED_SURFACES = ["bots", "routines", "webhooks", "zulip", "linear", "ios-push"];
export const REQUIRED_CHECKS = {
  import: ["parity", "read-only-archive"],
  rollback: ["restore-rehearsal", "restored-health"],
  "signed-release": ["codesign", "notarization", "staple", "installed-previous-build-update", "one-native-copy", "open-on-mac-target", "companion-without-electron"],
  "linux-retention": ["clean-export-build", "install-start", "update", "rollback"],
  "process-inventory": ["processes", "launchd", "listeners", "inventory-updated"],
  "control-disposition": ["owner-decision", "landed-implementation", "muster-disposition"],
  "change-plan": ["deletion-diff", "before-after-plan", "routine-webhook-disposition", "precise-rollback"],
};
const text = z.string().trim().min(1).max(2048);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: true });
const relativePath = z.string().min(1).max(240).refine((path) => /^[A-Za-z0-9_./-]+$/.test(path) && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
export const EvidenceRefSchema = z.strictObject({ path: relativePath, sha256: digest });
export const CandidateSchema = z.strictObject({ sourceSha: sha, build: z.string().regex(/^\d{12}$/), artifactSha256: digest });
const hosts = z.array(z.strictObject({ id: z.string().regex(HOST_ID_PATTERN), role: z.enum(["mac", "server"]) })).length(2).refine((items) => new Set(items.map((item) => item.role)).size === 2 && items.every((item) => item.id.startsWith(`${item.role}:`)));
const mode = z.enum(["localOnly", "serverFirst", "macFirst"]);
export const EvidenceBundleSchema = z.strictObject({
  version: z.literal(1), candidate: CandidateSchema, mode, hosts,
  acceptanceOwner: text, engines: z.array(text).min(1).max(32).refine((items) => new Set(items).size === items.length),
  state: EvidenceRefSchema,
  receipts: z.partialRecord(z.enum(REQUIRED_RECEIPTS), EvidenceRefSchema),
});
const check = z.strictObject({ name: text, exitCode: z.number().int(), artifact: EvidenceRefSchema });
const checks = z.array(check).min(1).max(64).refine((items) => new Set(items.map((item) => item.name)).size === items.length);
const observation = {
  startedAt: instant, endedAt: instant, log: EvidenceRefSchema,
  continuity: z.literal("uninterrupted"),
  selectedWriterHostId: z.string().regex(HOST_ID_PATTERN),
  controllerId: z.string().regex(HOST_ID_PATTERN), controllerEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const functionalSurfaces = z.strictObject(Object.fromEntries(REQUIRED_SURFACES.map((key) => [key, z.literal("passed")])));
const serverWriterSegment = z.strictObject({
  ...observation, macHarness: z.literal("loaded-unused"),
  surfaces: functionalSurfaces,
  inboundMessages: z.number().int().positive(),
  serverSharedRoutineRuns: z.number().int().nonnegative(), macSharedRoutineRuns: z.literal(0),
});
const noNodeSegment = z.strictObject({ ...observation, macHarness: z.literal("absent"), surfaces: functionalSurfaces });
const dailyDriverSegment = z.strictObject({
  ...observation, nativeApp: z.literal("signed-native-daily-driver"),
  iosSession: z.literal("passed"), openOnMac: z.literal("passed"), processInventory: z.literal("recorded"),
});
const soak = (segment) => z.strictObject({ startedAt: instant, endedAt: instant, segments: z.array(segment).min(1).max(64) });
const dataSchemas = {
  placement: z.strictObject({ manifest: EvidenceRefSchema, artifacts: z.array(EvidenceRefSchema).max(64) }),
  import: z.strictObject({ checks }),
  replay: z.strictObject({ checks }),
  rollback: z.strictObject({ checks }),
  "signed-release": z.strictObject({ checks, bundleId: z.literal("app.botfleet.macos"), teamId: text, designatedRequirement: text, previousBuild: z.string().regex(/^\d{12}$/) }),
  "linux-retention": z.strictObject({ checks, maintainedSourceSha: sha, rollbackSourceSha: sha, closureManifest: EvidenceRefSchema }),
  "process-inventory": z.strictObject({ checks, macHarness: z.literal("absent") }),
  "control-disposition": z.strictObject({ checks }),
  "change-plan": z.strictObject({ checks, jobs: z.array(text).min(1).max(64), files: z.array(text).min(1).max(512), appCopies: z.array(text).min(1).max(16) }),
  "server-writer-soak": soak(serverWriterSegment), "no-mac-node-soak": soak(noNodeSegment), "daily-driver": soak(dailyDriverSegment),
  "owner-acceptance": z.strictObject({ decision: z.literal("accepted"), action: z.literal("delete-mac-local-node-source"), dailyDriverAccepted: z.literal(true) }),
};
const receiptSchemas = Object.fromEntries(REQUIRED_RECEIPTS.map((kind) => [kind, z.strictObject({
  version: z.literal(1), kind: z.literal(kind), candidate: CandidateSchema, mode, hosts,
  provenance: z.strictObject({ by: text, at: instant, source: z.url().max(2048).refine((value) => value.startsWith("https://")), record: EvidenceRefSchema }),
  data: dataSchemas[kind],
})]));

class EvidenceFailure extends Error {}
export function evidenceHash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(code) { throw new EvidenceFailure(code); }
function diagnostic(error) { return error instanceof EvidenceFailure ? error.message : error.code === "ENOENT" ? "missing-file" : "invalid-or-unreadable-file"; }
function sameInode(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function privateEntry(stat) { return process.getuid && stat.uid === process.getuid() && (stat.mode & 0o077) === 0; }
function parseJson(bytes) { try { return JSON.parse(bytes.toString("utf8")); } catch { return fail("malformed-json"); } }
function parseSchema(schema, value) { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : fail("malformed-schema"); }
function sameCandidate(a, b) { return a.sourceSha === b.sourceSha && a.build === b.build && a.artifactSha256 === b.artifactSha256; }
function sameHosts(a, b) { return [...a].sort((x, y) => x.role.localeCompare(y.role)).every((item, index) => { const other = [...b].sort((x, y) => x.role.localeCompare(y.role))[index]; return item.id === other?.id && item.role === other.role; }); }

/** One bounded, private, single-link snapshot per relative bundle path. */
export function createEvidenceReader(directory) {
  const root = realpathSync(directory);
  const rootInode = lstatSync(root);
  if (!rootInode.isDirectory() || !privateEntry(rootInode)) fail("bundle-directory-not-private");
  let total = 0;
  const snapshot = new Map();
  const checkRoot = () => { const current = lstatSync(root); if (!current.isDirectory() || !privateEntry(current) || !sameInode(current, rootInode)) fail("bundle-directory-changed"); };
  const read = (path) => {
    parseSchema(relativePath, path);
    if (snapshot.has(path)) return snapshot.get(path);
    if (snapshot.size >= MAX_EVIDENCE_FILES) fail("too-many-evidence-files");
    checkRoot();
    let target = root;
    for (const name of path.split("/")) {
      target = join(target, name);
      const entry = lstatSync(target);
      if (entry.isSymbolicLink() || !privateEntry(entry)) fail("evidence-path-not-private");
    }
    if (realpathSync(target) !== target) fail("evidence-path-link");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || !privateEntry(before) || !sameInode(before, lstatSync(target))) fail("evidence-not-single-link-file");
      if (before.size > MAX_EVIDENCE_FILE_BYTES) fail("evidence-file-too-large");
      const buffer = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (count === 0) break; length += count; }
      if (length > MAX_EVIDENCE_FILE_BYTES) fail("evidence-file-too-large");
      const after = fstatSync(fd);
      const listed = lstatSync(target);
      checkRoot();
      if (!sameInode(before, after) || !sameInode(after, listed) || listed.isSymbolicLink() || listed.nlink !== 1 || !privateEntry(listed) || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || realpathSync(target) !== target) fail("evidence-file-changed");
      total += length;
      if (total > MAX_EVIDENCE_BUNDLE_BYTES) fail("evidence-bundle-too-large");
      const bytes = Buffer.from(buffer.subarray(0, length));
      snapshot.set(path, bytes);
      return bytes;
    } finally { closeSync(fd); }
  };
  return { root, read, snapshot };
}

export function readPrivateEvidenceFile(path) {
  const absolute = resolve(path);
  const reader = createEvidenceReader(dirname(absolute));
  return reader.read(relative(dirname(absolute), absolute).split(sep).join("/"));
}

export function readEvidenceRef(reader, reference) {
  const ref = parseSchema(EvidenceRefSchema, reference);
  const bytes = reader.read(ref.path);
  if (evidenceHash(bytes) !== ref.sha256) fail("evidence-hash-mismatch");
  return bytes;
}

export function parseEvidenceReceipt(kind, bytes) { return parseSchema(receiptSchemas[kind], parseJson(bytes)); }

export function assertReceiptBinding(receipt, bundle) {
  if (!sameCandidate(receipt.candidate, bundle.candidate) || receipt.mode !== bundle.mode || !sameHosts(receipt.hosts, bundle.hosts)) fail("receipt-identity-mismatch");
}

export function receiptReferences(receipt) {
  const refs = [receipt.provenance.record];
  for (const result of receipt.data.checks ?? []) refs.push(result.artifact);
  if (receipt.kind === "placement") refs.push(receipt.data.manifest, ...receipt.data.artifacts);
  if (receipt.kind === "linux-retention") refs.push(receipt.data.closureManifest);
  for (const span of receipt.data.segments ?? []) refs.push(span.log);
  return refs;
}

function checkInterval(receipt, bundle) {
  const { kind, data } = receipt;
  const start = Date.parse(data.startedAt);
  const end = Date.parse(data.endedAt);
  const requiredMs = (kind === "daily-driver" ? 7 : 1) * 24 * 60 * 60_000;
  if (end - start < requiredMs || Date.parse(receipt.provenance.at) < end) fail("incomplete-observation-interval");
  let cursor = start;
  let sharedRuns = 0;
  let previous;
  for (const span of data.segments) {
    if (Date.parse(span.startedAt) !== cursor || Date.parse(span.endedAt) <= cursor || Date.parse(span.endedAt) > end) fail("observation-coverage-gap-or-overlap");
    if (!bundle.hosts.some((host) => host.id === span.selectedWriterHostId)) fail("unknown-observed-writer");
    if (!bundle.hosts.some((host) => host.id === span.controllerId)) fail("unknown-observed-controller");
    if (previous) checkControllerFence(previous, span);
    if (kind === "server-writer-soak" && !span.selectedWriterHostId.startsWith("server:")) fail("server-writer-not-observed");
    cursor = Date.parse(span.endedAt);
    sharedRuns += span.serverSharedRoutineRuns ?? 0;
    previous = span;
  }
  if (cursor !== end) fail("incomplete-observation-coverage");
  if (kind === "server-writer-soak") {
    const elapsedDays = (end - start) / (24 * 60 * 60_000);
    if (sharedRuns < Math.floor(elapsedDays) || sharedRuns > Math.ceil(elapsedDays)) fail("shared-routine-run-count-mismatch");
  }
}

function checkControllerFence(previous, next) {
  if (next.controllerEpoch < previous.controllerEpoch || (next.controllerId !== previous.controllerId && next.controllerEpoch <= previous.controllerEpoch)) fail("controller-fence-regressed-or-unadvanced-handoff");
}

/** Validate already captured bytes; no network, subprocess or host probe. */
export function checkFinalEvidenceBundle(path, { statePath, stateBytes, candidate, now = Date.now() }) {
  const blockers = [];
  const receipts = new Map();
  let reader;
  let bundle;
  try {
    reader = createEvidenceReader(dirname(resolve(path)));
    bundle = parseSchema(EvidenceBundleSchema, parseJson(reader.read(basename(path))));
    if (!sameCandidate(bundle.candidate, parseSchema(CandidateSchema, candidate))) fail("candidate-mismatch");
    const physicalState = join(realpathSync(dirname(resolve(statePath))), basename(statePath));
    if (physicalState !== join(reader.root, bundle.state.path) || !readEvidenceRef(reader, bundle.state).equals(stateBytes)) fail("state-file-mismatch");
  } catch (error) { return { ok: false, blockers: [`bundle: ${diagnostic(error)}`] }; }
  for (const kind of REQUIRED_RECEIPTS) {
    try {
      if (!bundle.receipts[kind]) fail("missing-receipt");
      const receipt = parseEvidenceReceipt(kind, readEvidenceRef(reader, bundle.receipts[kind]));
      assertReceiptBinding(receipt, bundle);
      if (Date.parse(receipt.provenance.at) > now) fail("observation-is-in-the-future");
      for (const ref of receiptReferences(receipt)) readEvidenceRef(reader, ref);
      const results = receipt.data.checks ?? [];
      if (results.some((result) => result.exitCode !== 0)) fail("command-did-not-pass");
      const required = kind === "replay" ? bundle.engines.map((engine) => `engine:${engine}`) : REQUIRED_CHECKS[kind] ?? [];
      if (required.some((name) => !results.some((result) => result.name === name))) fail("missing-command-result");
      if (kind === "placement") {
        const allowed = new Map(receipt.data.artifacts.map((ref) => [ref.path, ref]));
        const manifest = parseJson(readEvidenceRef(reader, receipt.data.manifest));
        const verdict = checkPlacementEvidenceArtifacts(manifest, (name) => {
          const ref = allowed.get(posix.join(posix.dirname(receipt.data.manifest.path), name));
          if (!ref) fail("placement-artifact-not-hash-bound");
          return readEvidenceRef(reader, ref);
        });
        if (!verdict.ok) { blockers.push(...verdict.blockers.map((blocker) => `placement: ${blocker}`)); continue; }
      }
      if (receipt.data.segments) checkInterval(receipt, bundle);
      if (kind === "owner-acceptance" && receipt.provenance.by !== bundle.acceptanceOwner) fail("acceptance-owner-mismatch");
      if (kind === "signed-release" && receipt.data.previousBuild === bundle.candidate.build) fail("previous-build-not-distinct");
      receipts.set(kind, receipt);
    } catch (error) { blockers.push(`${kind}: ${diagnostic(error)}`); }
  }
  const first = receipts.get("server-writer-soak");
  const second = receipts.get("no-mac-node-soak");
  if (first && second && Date.parse(first.data.endedAt) > Date.parse(second.data.startedAt)) blockers.push("soaks: server-writer-soak must precede no-mac-node-soak");
  if (first && second) {
    try { checkControllerFence(first.data.segments.at(-1), second.data.segments[0]); }
    catch { blockers.push("soaks: controller-fence-regressed-or-unadvanced-handoff"); }
  }
  const accepted = receipts.get("owner-acceptance");
  if (accepted && [...receipts.values()].some((receipt) => Date.parse(receipt.provenance.at) > Date.parse(accepted.provenance.at))) blockers.push("owner-acceptance: predates-evidence");
  return { ok: blockers.length === 0, blockers, verifiedFiles: reader.snapshot.size };
}
