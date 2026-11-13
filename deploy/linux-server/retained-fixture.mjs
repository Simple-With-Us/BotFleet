// Source-fixture orchestration only: no service, account, mount, network,
// credential, package-install or process-start adapter is supplied here.
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ClosureReceiptSchema } from "../../scripts/linux-retained-source.mjs";
import { exportLinuxClosure } from "../../scripts/collect-linux-retained-source.mjs";
import { createFilteredLinuxCheckout } from "../../scripts/linux-retained-checkout.mjs";

export const FIXTURE_ACTIONS = ["installDependencies", "buildUi", "start", "health", "stop"];

const portEvidence = z.number().int().min(1025).max(65535).refine((value) => value !== 8799).optional();
export const evidenceSchema = z.strictObject({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  httpPort: portEvidence, webhookPort: portEvidence, uiPort: portEvidence,
  uiHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  version: z.string().regex(/^[A-Za-z0-9.+_-]{1,128}$/).optional(),
  executable: z.string().min(1).max(512).refine((value) => value.startsWith("/") && !/[\r\n\0\u0085\u2028\u2029]/.test(value)).optional(),
  joined: z.boolean().optional(), sourceSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
});

function boundedEvidence(result, sourceSha) {
  const evidence = {};
  for (const key of evidenceSchema.keyof().options) {
    if (result[key] !== undefined) evidence[key] = result[key];
  }
  if (evidence.sourceSha !== undefined && evidence.sourceSha !== sourceSha) throw new Error("Fixture evidence source changed");
  return evidenceSchema.parse(evidence);
}

export function linuxFixturePlan(candidateRaw, priorRaw, materialization = "export") {
  const candidate = ClosureReceiptSchema.parse(candidateRaw);
  const prior = ClosureReceiptSchema.parse(priorRaw);
  if (candidate.sourceSha === prior.sourceSha) throw new Error("Rollback requires a distinct known prior source");
  if (!["export", "filtered-git"].includes(materialization)) throw new Error("Unknown fixture materialization");
  return {
    version: 1, maintainedRef: "main", proof: "isolated-source-fixture-only",
    candidate, prior, materialization,
    phases: ["export-both", "install-and-build-prior", "prior-start-health", "install-and-build-candidate", "candidate-update-health", "prior-rollback-health"],
    liveActions: [],
  };
}

/** Default is a read-only plan; explicit execution needs every injected adapter. */
export async function runLinuxClosureFixture({ repo, candidate, prior, output, execute = false, adapters, materialization = "export", materializeLfs, preparedRoot = false }) {
  const plan = linuxFixturePlan(candidate, prior, materialization);
  if (!execute) return { plan, executed: false, preservation: "not-established" };
  if (!adapters || FIXTURE_ACTIONS.some((name) => !adapters[name])) throw new Error("Explicit isolated fixture adapters are required before creating any files");
  const root = resolve(output);
  if (!preparedRoot) mkdirSync(root, { mode: 0o700 });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.uid !== process.getuid() ||
      (rootStat.mode & 0o7777) !== 0o700 || realpathSync(root) !== root) {
    throw new Error("Fixture root must be an owned private real directory");
  }
  const slots = { prior: join(root, "prior"), candidate: join(root, "candidate") };
  // Refuse both destinations before materializing either, including dangling links.
  for (const destination of Object.values(slots)) {
    try { lstatSync(destination); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    throw new Error("Fixture slot destination already exists");
  }
  const receipts = { prior: plan.prior, candidate: plan.candidate };
  const trace = [];
  const active = new Set();
  const call = async (action, slot) => {
    const context = { root, exportRoot: slots[slot], sourceSha: receipts[slot].sourceSha, toolchain: receipts[slot].toolchain, slot, sourceReceipt: receipts[slot] };
    if (action === "start") active.add(slot);
    const result = await adapters[action](context);
    if (!result || result.ok !== true) throw new Error(`Fixture ${action} failed for ${slot}`);
    trace.push({ action, slot, sourceSha: context.sourceSha, evidence: boundedEvidence(result, context.sourceSha) });
    if (action === "stop") active.delete(slot);
    return result;
  };
  let candidateHealthy = false;
  let rolledBack = false;
  const cleanupFailures = [];
  try {
    for (const slot of ["prior", "candidate"]) {
      if (materialization === "filtered-git") await createFilteredLinuxCheckout({ repo, receipt: receipts[slot], output: slots[slot], execute: true, materializeLfs });
      else await exportLinuxClosure(repo, receipts[slot], slots[slot], receipts[slot].sourceSha, receipts[slot].policySourceSha, receipts[slot].policyPath);
    }
    await call("installDependencies", "prior");
    await call("buildUi", "prior");
    await call("start", "prior");
    await call("health", "prior");
    await call("stop", "prior");
    await call("installDependencies", "candidate");
    await call("buildUi", "candidate");
    await call("start", "candidate");
    try { await call("health", "candidate"); candidateHealthy = true; }
    finally { await call("stop", "candidate"); }
  } catch {
    trace.push({ action: "candidate-refused", reason: "An isolated fixture phase did not complete safely" });
  } finally {
    // Join cleanup even if a failed start or stop left a fixture child alive.
    for (const slot of active) { try { await call("stop", slot); } catch { cleanupFailures.push(slot); } }
    if (adapters.cleanup) {
      try { if ((await adapters.cleanup())?.ok !== true) cleanupFailures.push("adapter-processes"); }
      catch { cleanupFailures.push("adapter-processes"); }
    }
    if (active.size === 0 && cleanupFailures.length === 0 && trace.some((step) => step.action === "health" && step.slot === "prior")) {
      try { await call("start", "prior"); await call("health", "prior"); rolledBack = true; }
      catch { trace.push({ action: "rollback-refused" }); }
      finally { if (active.has("prior")) { try { await call("stop", "prior"); } catch { cleanupFailures.push("prior"); } } }
    }
  }
  return { executed: true, proof: plan.proof, candidateHealthy, rollbackHealthy: rolledBack, cleanupFailures, preservation: "external-runtime-acceptance-still-required", trace };
}
