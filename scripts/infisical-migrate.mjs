// One-way seeding helper: local config -> Infisical.  The orchestrator runs
// this by hand after I2 + I7 land; nothing in the product calls it.
//
// Reads the same config `loadConfig()` would resolve for a running server —
// ~/.botfleet/config.json (or $OMB_DATA_DIR/config.json), with the env
// overlay `loadConfig()` already applies, INCLUDING the Infisical machine
// identity itself (`infisical.*` in the file, or `INFISICAL_CLIENT_ID` /
// `INFISICAL_CLIENT_SECRET` in the environment, env winning — see
// `server/config.ts`'s `loadConfig()`).  That reuse is deliberate: the
// identity-resolution rule lives in exactly one place, so this script cannot
// drift from what the server itself would have used to reach the vault.
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

import { loadConfig, infisicalSettings, infisicalConfigured } from "../server/config.ts";
import { SECRET_FIELDS } from "../server/secret-map.ts";
import { login, listSecrets, upsertSecret } from "../server/infisical-client.ts";

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

/** The token each side of the vault uses.
 *
 * A read token and a write token are two different credentials, and a read
 * token cannot write.  So the write side uses the write token when there is
 * one, falls back to the machine identity when there is not, and reports NO
 * write credential when neither is there: passing the read token to a write
 * fails with a 403 that reads like a broken vault rather than a missing
 * write credential.
 *
 * Returns `{ readToken, writeToken }`.  `writeToken` is the EMPTY string when
 * this install has no write credential at all, and the caller says so rather
 * than trying the write anyway.  A failed machine login throws, exactly as
 * the previous inline login did. */
export async function resolveVaultTokens(settings, { loginImpl = login } = {}) {
  const readToken = settings.token.trim();
  const writeToken = settings.writeToken.trim();
  const loginArgs = {
    siteUrl: settings.siteUrl,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
  };
  if (readToken) {
    if (writeToken) return { readToken, writeToken };
    // The read token cannot write, so the write falls back to the machine
    // identity when this host still has one.
    try {
      return { readToken, writeToken: await loginImpl(loginArgs) };
    } catch {
      return { readToken, writeToken: "" };
    }
  }
  const machine = await loginImpl(loginArgs);
  return { readToken: machine, writeToken: writeToken || machine };
}

export async function run({
  argv = process.argv.slice(2),
  log = (line) => console.log(line),
  err = (line) => console.error(line),
  loadConfigImpl = loadConfig,
  loginImpl = login,
  listSecretsImpl = listSecrets,
  upsertSecretImpl = upsertSecret,
} = {}) {
  const apply = argv.includes("--apply");

  const cfg = loadConfigImpl();

  if (!infisicalConfigured(cfg)) {
    err(
      "Infisical is not configured -- add a project id and an identity first " +
        "(INFISICAL_TOKEN / INFISICAL_WRITE_TOKEN, or INFISICAL_CLIENT_ID / " +
        "INFISICAL_CLIENT_SECRET, in the environment, infisical.* in " +
        "~/.botfleet/config.json, or Settings > Secrets once the harness is running).",
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

  // A service token is the identity; the machine identity is the fallback.
  let tokens;
  try {
    tokens = await resolveVaultTokens(settings, { loginImpl });
  } catch (caught) {
    err(`Could not log in to Infisical: ${caught instanceof Error ? caught.message : "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  const token = tokens.readToken;

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
  } catch (caught) {
    err(`Could not list Infisical secrets: ${caught instanceof Error ? caught.message : "unknown error"}`);
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
    log("");
    log("Dry run only -- nothing written.  Re-run with --apply to upsert the rows above not already present-and-same.");
    return;
  }

  if (!tokens.writeToken) {
    err(
      "This install has no write credential: set INFISICAL_WRITE_TOKEN (or " +
        "infisical.writeToken in the config file), or keep the machine " +
        "identity so the script can log in and write as it always did.",
    );
    process.exitCode = 1;
    return;
  }

  log("");
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
    } catch (caught) {
      err(`failed ${spec.infisicalName}: ${caught instanceof Error ? caught.message : "unknown error"}`);
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
