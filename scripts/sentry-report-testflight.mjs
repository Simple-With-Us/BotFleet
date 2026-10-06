import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateReceipt } from "./sentry-testflight-receipt.mjs";

const API = "https://sentry.io/api/0/organizations/simple-with-us/releases/";
const REPOSITORY = "Simple-With-Us/BotFleet";
// Sentry retains the pre-transfer name.  Its externalId 1349857130 matches
// the current GitHub repository's stable ID; refs use Sentry's configured name.
const SENTRY_REPOSITORY = "jaywedgeworth22/BotFleet";

export async function reportTestFlight(receipt, { token, runId, fetchImpl = fetch } = {}) {
  validateReceipt(receipt);
  if (!token?.trim()) throw new Error("SENTRY_AUTH_TOKEN is required for deployment reporting");
  if (!/^\d+$/.test(runId ?? "")) throw new Error("A verified GitHub run ID is required");
  async function request(method, url, body, allowMissing = false) {
    let response;
    try {
      response = await fetchImpl(url, { method, redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error(`Sentry ${method} request failed; inspect reporting before retrying`); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Sentry ${method} failed (HTTP ${response.status})`);
    try { return await response.json(); }
    catch { throw new Error("Sentry returned invalid JSON"); }
  }
  const releaseUrl = `${API}${encodeURIComponent(receipt.release)}/`;
  const existing = await request("GET", releaseUrl, undefined, true);
  if (existing?.ref && existing.ref !== receipt.sourceCommit) throw new Error("Existing Sentry release refers to a different source commit");
  if (existing && !existing.projects?.some((project) => project.slug === "botfleet")) throw new Error("Existing Sentry release does not belong to botfleet");
  const metadata = { ref: receipt.sourceCommit,
    refs: [{ repository: SENTRY_REPOSITORY, commit: receipt.sourceCommit }],
    url: `https://github.com/${REPOSITORY}/commit/${receipt.sourceCommit}`,
    dateReleased: receipt.confirmedAt };
  await request(existing ? "PUT" : "POST", existing ? releaseUrl : API,
    existing ? metadata : { ...metadata, version: receipt.release, projects: ["botfleet"] });

  // Use the environment already emitted by SentryTelemetry.swift.  The name
  // explicitly identifies distribution readiness, never device installation.
  const name = `ios-testflight:${receipt.buildNumber}`;
  const deploys = await request("GET", `${releaseUrl}deploys/`);
  if (!Array.isArray(deploys)) throw new Error("Sentry returned an invalid deploy list");
  const match = deploys.find((deploy) => deploy.environment === "production" && deploy.name === name);
  if (match) return { release: receipt.release, deployId: match.id, alreadyRecorded: true };
  // Do not automatically retry a write with an uncertain outcome.  A rerun
  // checks the deterministic release/environment/name before creating it.
  const deploy = await request("POST", `${releaseUrl}deploys/`, { environment: "production", projects: ["botfleet"],
    name, dateFinished: receipt.confirmedAt, url: `https://github.com/${REPOSITORY}/actions/runs/${runId}` });
  if (!deploy?.id) throw new Error("Sentry did not return a deployment receipt");
  return { release: receipt.release, deployId: deploy.id, alreadyRecorded: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await reportTestFlight(JSON.parse(process.env.SENTRY_DEPLOY_RECEIPT || "null"), {
      token: process.env.SENTRY_AUTH_TOKEN, runId: process.env.GITHUB_RUN_ID });
    const summary = `Sentry recorded ${result.release}: TestFlight ready for internal testers.  This is not proof of installation on a device.\n`;
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    // Only locally authored messages reach logs; response bodies and credentials never do.
    console.error(`::error::${error instanceof SyntaxError ? "Invalid TestFlight receipt JSON" : error.message}`);
    process.exitCode = 1;
  }
}
