// One-way seeding helper: local config -> Infisical.  The orchestrator runs
// this by hand after I2 + I7 land; nothing in the product calls it.
//
// Reads the same config `loadConfig()` would resolve for a running server —
// ~/.botfleet/config.json (or $OMB_DATA_DIR/config.json), with the env
// overlay that loadConfig() already applies.  This managed helper accepts only
// dedicated primary-scope service tokens and never authenticates a machine identity.
//
// Walks `SECRET_FIELDS` (`server/secret-map.ts`) and, for every field that
// has a non-empty LOCAL value, reports whether Infisical already holds that
// name and whether the value matches -- by comparing sha256 digests, never
// the raw values.  Dry run is the default and prints only that report.
// `--apply` additionally upserts every row not already `present-and-same`,
// one name at a time, through `server/infisical-client.ts` -- the same wire
// client the running server uses.
//
// Guarantees this file exists to keep:
//   - Never reads the retired secrets folder or any fleet handoff file.  The identity is
//     config-file-or-env only, exactly as the server resolves it.
//   - Never accepts a credential on the command line -- there is no flag for
//     one.
//   - Never prints a secret value.  Local values and vault values exist only
//     long enough to be hashed and compared; only ids, Infisical names,
//     status words and counts ever reach `console.log`.
//   - Empty local values are always skipped -- there is nothing to seed.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig, infisicalSettings, infisicalConfigured, normalizeInfisicalSecretPath } from "../server/config.ts";
import { SECRET_FIELDS } from "../server/secret-map.ts";
import { listSecrets, upsertSecret, verifyServiceToken } from "../server/infisical-client.ts";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Read-only mirror of `secret-map.ts`'s private `readField` -- this script
 * intentionally does not import that internal, so it stays free to read
 * without ever being able to write into the live `cfg` object it is handed. */
export function localValueFor(cfg, spec) {
  let node = cfg[spec.section];
  for (const key of spec.path) {
    if (!node || typeof node !== "object") return "";
    node = node[key];
  }
  return typeof node === "string" ? node : "";
}

/** `absent` (vault has no non-empty value for this name), `present-and-same`
 * (hashes match -- nothing to do), or `present-and-different` (a write would
 * change the vault's value).  Pure and synchronous so it is trivial to check
 * without any network access. */
export function classify(localValue, vaultValue) {
  if (typeof vaultValue !== "string" || vaultValue.length === 0) return "absent";
  return sha256(localValue) === sha256(vaultValue) ? "present-and-same" : "present-and-different";
}

/** Every mapped field that has a non-empty local value right now, paired
 * with that value.  Order follows `SECRET_FIELDS`. */
export function rowsWithLocalValues(cfg) {
  const rows = [];
  for (const spec of SECRET_FIELDS) {
    const local = localValueFor(cfg, spec);
    if (local.length > 0) rows.push({ spec, local });
  }
  return rows;
}

/** Managed migrations use a dedicated read token and a separate write token.
 * Product machine identity selection never authorizes this helper to log in. */
export async function resolveVaultTokens(settings) {
  if (settings.authMethod === "machine-identity") throw new Error("Managed migration requires service-token authentication; machine identities are not used.");
  const matchingSource = (settings.readSources ?? []).find((source) => source.projectId === settings.projectId &&
    source.environment === settings.environment && normalizeInfisicalSecretPath(source.secretPath) === normalizeInfisicalSecretPath(settings.secretPath));
  if (matchingSource) throw new Error("This migration helper does not load scoped source locators; use the app write-through path for that configured source.");
  const readToken = settings.token.trim();
  if (!readToken) throw new Error("Managed migration requires a dedicated Infisical read service token.");
  return { readToken, writeToken: settings.writeToken.trim() };
}

export async function run({
  argv = process.argv.slice(2),
  log = (line) => console.log(line),
  err = (line) => console.error(line),
  loadConfigImpl = loadConfig,
  listSecretsImpl = listSecrets,
  upsertSecretImpl = upsertSecret,
  verifyServiceTokenImpl = verifyServiceToken,
} = {}) {
  const apply = argv.includes("--apply");

  const cfg = loadConfigImpl();

  if (!infisicalConfigured(cfg)) {
    err(
      "Infisical migration is pending: configure a project and a dedicated read service token; --apply also requires a separate write service token.",
    );
    process.exitCode = 1;
    return;
  }
  const settings = infisicalSettings(cfg);

  const rows = rowsWithLocalValues(cfg);
  const skipped = SECRET_FIELDS.length - rows.length;
  if (rows.length === 0) {
    log("No mapped credential has a local value on this machine -- nothing to migrate.");
    return;
  }

  // Managed helpers never activate the product machine identity option.
  let tokens;
  try {
    tokens = await resolveVaultTokens(settings);
  } catch (caught) {
    err(`Could not select Infisical migration credentials: ${caught instanceof Error ? caught.message : "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  if (apply && !tokens.writeToken) {
    err("Infisical migration is pending: --apply requires a dedicated write service token for this exact scope.");
    process.exitCode = 1;
    return;
  }
  const token = tokens.readToken;

  try {
    await verifyServiceTokenImpl({
      siteUrl: settings.siteUrl,
      token,
      projectId: settings.projectId,
      environment: settings.environment,
      secretPath: settings.secretPath,
      mode: "read",
    });
    if (apply) {
      await verifyServiceTokenImpl({
        siteUrl: settings.siteUrl,
        token: tokens.writeToken,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        mode: "write",
      });
    }
  } catch {
    err("Could not verify the configured Infisical service-token scope; no secrets were read or written.");
    process.exitCode = 1;
    return;
  }

  let vaultValues;
  try {
    const listed = await listSecretsImpl({
      siteUrl: settings.siteUrl,
      token,
      projectId: settings.projectId,
      environment: settings.environment,
      secretPath: settings.secretPath,
      viewValues: true,
    });
    vaultValues = listed.values;
  } catch {
    err("Could not list Infisical secrets with the configured service token; no alternate identity was tried.");
    process.exitCode = 1;
    return;
  }

  log(
    `Infisical ${settings.environment} at ${settings.secretPath} on ${settings.siteUrl}` +
      (apply ? " (--apply: writing changes)" : " (dry run -- pass --apply to write)") +
      ":",
  );
  const classified = rows.map(({ spec, local }) => ({ spec, local, status: classify(local, vaultValues.get(spec.infisicalName)) }));
  for (const { spec, status } of classified) {
    log(`  ${spec.id} -> ${spec.infisicalName}  (local value present, vault: ${status})`);
  }
  if (skipped > 0) {
    log(`  (${skipped} mapped field${skipped === 1 ? "" : "s"} with no local value skipped)`);
  }

  if (!apply) {
    log("Dry run only -- nothing written.  Re-run with --apply to upsert the rows above not already present-and-same.");
    return;
  }

  for (const { spec, local, status } of classified) {
    if (status === "present-and-same") {
      log(`skipped ${spec.infisicalName} (unchanged)`);
      continue;
    }
    try {
      await upsertSecretImpl({
        siteUrl: settings.siteUrl,
        // The WRITE token.  A read token cannot write, so it is never the
        // one used here: it would fail with a 403 that reads like a broken
        // vault instead of a missing write credential.
        token: tokens.writeToken,
        projectId: settings.projectId,
        environment: settings.environment,
        secretPath: settings.secretPath,
        name: spec.infisicalName,
        value: local,
      });
      log(`wrote ${spec.infisicalName}`);
    } catch {
      err(`failed ${spec.infisicalName}: the configured write service token could not complete the upsert.`);
      process.exitCode = 1;
    }
  }
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

const isMain = isEntryModule();
if (isMain) {
  run().catch((caught) => {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  });
}
