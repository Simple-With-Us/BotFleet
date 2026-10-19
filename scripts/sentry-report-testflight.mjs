import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateReceipt } from "./sentry-testflight-receipt.mjs";

const API = "https://sentry.io/api/0/organizations/simple-with-us/releases/";
// One constant, because Sentry's refs[].repository must match the repository
// name Sentry has registered -- and that is this repository, post-transfer.
// A second "Sentry keeps the pre-transfer name" constant is what turned every
// ship red: Sentry rejects the whole write with HTTP 400
// {"refs":["Invalid repository names: jaywedgeworth22/BotFleet"]}.
const REPOSITORY = "Simple-With-Us/BotFleet";

const ReceiptSchema = z.object({
  schema: z.literal(1),
  milestone: z.literal("testflight-ready"),
  bundleId: z.literal("app.botfleet.ios"),
  marketingVersion: z.string().regex(/^1\.0\.\d+$/),
  buildNumber: z.string().regex(/^\d{12}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  ascBuildId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  state: z.enum(["IN_BETA_TESTING", "READY_FOR_BETA_TESTING"]),
  confirmedAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  release: z.string(),
}).strict();

const SentryProjectSchema = z.object({ slug: z.string() }).passthrough();
// Sentry answers an unset field with null, not by omitting it.  The ship's own
// sentry-cli upload creates this release first, with no ref, so the first read
// here is {"ref": null}; a strict optional string rejected it as invalid JSON
// and turned every ship red.  Unnamed deploys of other pipelines also carry
// {"name": null}.
const SentryReleaseSchema = z.object({
  ref: z.string().nullish(),
  projects: z.array(SentryProjectSchema).optional(),
}).passthrough();
const SentryDeploySchema = z.object({
  id: z.union([z.string(), z.number()]),
  environment: z.string().nullish(),
  name: z.string().nullish(),
}).passthrough();

function parseApi(schema, raw) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("Sentry returned invalid JSON");
  return parsed.data;
}

// JSON.parse accepts a scalar or an array as readily as an object, and neither is
// a Sentry field-level error map.  Only a plain object counts as a reportable
// validation body.
function parseJsonObject(body) {
  const value = parseJson(body);
  return value && !Array.isArray(value) ? value : null;
}

function parseJson(body) {
  try { return JSON.parse(body); }
  catch { return null; }
}

// Sentry puts the actionable reason in the error body ("Invalid repository
// names: ...", a field-level validation map).  Discarding it is what made this
// cost three fixes: each one cleared a layer and hid the next behind the same
// bare "HTTP 400".  Surface the JSON validation error Sentry returns, and only
// that -- a non-JSON body (a gateway page, a proxy string, an opaque upstream
// error) is exactly the shape that can echo something sensitive, so it is never
// echoed back.  The body is redacted and truncated regardless.
async function describeFailure(response, token) {
  let body;
  try { body = await response.text(); }
  catch { return ""; }
  if (!body?.trim()) return "";
  // Parse at the boundary once.  Sentry's field-level errors are a JSON object;
  // an array, a scalar or unparseable text is not one, and is not reported.
  const parsed = parseJsonObject(body);
  if (!parsed) return "";
  const scrubbed = JSON.stringify(parsed)
    .split(token)
    .join("[redacted]")
    .replace(/bearer\s+[\w.-]+/gi, "bearer [redacted]")
    .replace(/(["']?(?:token|secret|authorization|dsn|password)["']?\s*[:=]\s*)["']?[^"',}\s]+/gi, "$1[redacted]");
  return `: ${scrubbed.replace(/\s+/g, " ").slice(0, 300)}`;
}

export async function reportTestFlight(receipt, { token, runId, fetchImpl = fetch } = {}) {
  const checked = ReceiptSchema.safeParse(validateReceipt(receipt));
  if (!checked.success) throw new Error("Invalid verified TestFlight receipt");
  receipt = checked.data;
  if (!token?.trim()) throw new Error("SENTRY_AUTH_TOKEN is required for deployment reporting");
  if (!/^\d+$/.test(runId ?? "")) throw new Error("A verified GitHub run ID is required");
  async function request(method, url, body, allowMissing = false) {
    let response;
    try {
      const init = {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      };
      if (body) init.body = JSON.stringify(body);
      response = await fetchImpl(url, init);
    } catch { throw new Error(`Sentry ${method} request failed; inspect reporting before retrying`); }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`Sentry ${method} failed (HTTP ${response.status})${await describeFailure(response, token)}`);
    try { return await response.json(); }
    catch { throw new Error("Sentry returned invalid JSON"); }
  }
  const releaseUrl = `${API}${encodeURIComponent(receipt.release)}/`;
  const existingRaw = await request("GET", releaseUrl, undefined, true);
  const existing = existingRaw == null ? null : parseApi(SentryReleaseSchema, existingRaw);
  if (existing?.ref && existing.ref !== receipt.sourceCommit) throw new Error("Existing Sentry release refers to a different source commit");
  if (existing && !existing.projects?.some((project) => project.slug === "botfleet")) throw new Error("Existing Sentry release does not belong to botfleet");
  const metadata = { ref: receipt.sourceCommit,
    refs: [{ repository: REPOSITORY, commit: receipt.sourceCommit }],
    url: `https://github.com/${REPOSITORY}/commit/${receipt.sourceCommit}`,
    dateReleased: receipt.confirmedAt };
  const writeBody = existing ? metadata : { version: receipt.release, projects: ["botfleet"], ref: metadata.ref, refs: metadata.refs, url: metadata.url, dateReleased: metadata.dateReleased };
  await request(existing ? "PUT" : "POST", existing ? releaseUrl : API, writeBody);

  // Use the environment already emitted by SentryTelemetry.swift.  The name
  // explicitly identifies distribution readiness, never device installation.
  const name = `ios-testflight:${receipt.buildNumber}`;
  const deploys = parseApi(z.array(SentryDeploySchema), await request("GET", `${releaseUrl}deploys/`));
  const match = deploys.find((deploy) => deploy.environment === "production" && deploy.name === name);
  if (match) return { release: receipt.release, deployId: match.id, alreadyRecorded: true };
  // Do not automatically retry a write with an uncertain outcome.  A rerun
  // checks the deterministic release/environment/name before creating it.
  const deploy = parseApi(SentryDeploySchema, await request("POST", `${releaseUrl}deploys/`, { environment: "production", projects: ["botfleet"],
    name, dateFinished: receipt.confirmedAt, url: `https://github.com/${REPOSITORY}/actions/runs/${runId}` }));
  if (deploy.id === "" || deploy.id == null) throw new Error("Sentry did not return a deployment receipt");
  return { release: receipt.release, deployId: deploy.id, alreadyRecorded: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let parsed;
    try {
      parsed = JSON.parse(process.env.SENTRY_DEPLOY_RECEIPT || "null");
    } catch {
      throw new SyntaxError("Invalid TestFlight receipt JSON");
    }
    const result = await reportTestFlight(parsed, {
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
