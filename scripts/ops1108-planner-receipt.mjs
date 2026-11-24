// The synthetic receipt for the shared release planner (OPS-1108).
//
// The receipt answers one question: does ONE commit carry ONE build
// number on both platforms? It names the commit, the merge stamp the
// two platforms derive from it, and the build the iOS plan and the Mac plan
// of that commit each carry.
//
// IT IS A FIXTURE, NOT PROOF OF A HOSTED RUN. The inventory it plans
// over is synthetic, it never reads the store, it never reads the
// environment, and it carries no credential value: every secret is
// named with the store it lives in and the grant that reads it, and its
// value is a redacted placeholder. A receipt that claimed to prove a
// hosted run would be a claim this producer cannot make, so the receipt says
// so in its own fields.
//
// The plan it prints is the shared planner's own:
// scripts/ios-fleet/shared-build.mjs nextSharedBuild, asked once with
// platform "ios" and once with platform "macos" over ONE inventory, which
// is what makes the two answers comparable. The Mac release planner
// (scripts/mac-release-version.mjs) asks the same planner for the same
// commit, so the receipt and a live plan cannot disagree about the number.
//
// The merge stamp is the commit's committer date in America/Chicago, written
// YYYYMMDDHHMM, and it is read through the same helper the Mac planner reads
// it with.
//
// Usage:
//   node scripts/ops1108-planner-receipt.mjs --out <file>
//   node scripts/ops1108-planner-receipt.mjs --repo-root . --sha HEAD
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { nextSharedBuild } from "./ios-fleet/shared-build.mjs";
import { DEFAULT_MARKETING_VERSION, committerDateFor, mergeStampFor } from "./mac-release-version.mjs";

/** The receipt's own version. */
export const RECEIPT_SCHEMA = 1;

/** The kind every reader looks for before it trusts a receipt. */
export const RECEIPT_KIND = "ops1108-planner-receipt";

/** What every secret's value is replaced with. Never a value. */
export const REDACTED_VALUE = "sha256:redacted";

/** The commit identity the fixture uses when no commit is named. */
export const FIXTURE_COMMIT = "1111111111111111111111111111111111111111";

/** The merge stamp the fixture uses when no stamp is named. */
export const FIXTURE_MERGE_STAMP = "202611231950";

/**
 * The synthetic inventory the fixture plans over.
 *
 * The builds are a timestamp-shaped pair, so the fixture looks like a real
 * inventory without being one, and the merge stamp is above them, so the
 * plan of one commit is the stamp itself.
 */
export const FIXTURE_INVENTORY = {
  iosBuilds: ["202611221200"],
  macBuilds: ["202611221200"],
  extraFloors: [],
};

/**
 * Every credential the hosted planner path resolves, with the store it comes
 * from and the grant that reads it.
 *
 * The value is never here: a receipt that carried one would be a copy
 * of a secret, and a fixture is already not proof, so a fixture with a
 * secret in it is worse than no fixture at all.
 */
export const PLANNER_CREDENTIALS = [
  { name: "ASC_KEY_ID", store: "Infisical fleet-ops prod /asc", grant: "fleet-tools-mm-asc-ro", scope: "read" },
  { name: "ASC_ISSUER_ID", store: "Infisical fleet-ops prod /asc", grant: "fleet-tools-mm-asc-ro", scope: "read" },
  { name: "ASC_KEY_P8", store: "Infisical fleet-ops prod /asc", grant: "fleet-tools-mm-asc-ro", scope: "read" },
  { name: "APPLE_API_KEY_ID", store: "Infisical fleet-ops prod /asc", grant: "hosted job service token", scope: "read" },
  { name: "APPLE_API_ISSUER_ID", store: "Infisical fleet-ops prod /asc", grant: "hosted job service token", scope: "read" },
  { name: "APPLE_API_KEY_P8_BASE64", store: "Infisical fleet-ops prod /asc", grant: "hosted job service token", scope: "read" },
  { name: "IOS_CERT_P12_BASE64", store: "Infisical fleet-ops prod /", grant: "INFISICAL_IOS_SHIP_READ_TOKEN", scope: "read" },
  { name: "IOS_CERT_PASSWORD", store: "Infisical fleet-ops prod /", grant: "INFISICAL_IOS_SHIP_READ_TOKEN", scope: "read" },
  { name: "SENTRY_DSN", store: "Infisical fleet-ops prod /global-api-keys", grant: "sentry read token", scope: "read" },
  { name: "SENTRY_AUTH_TOKEN", store: "Infisical fleet-ops prod /global-api-keys", grant: "sentry read token", scope: "read" },
];

/**
 * The receipt for one commit's shared plan.
 *
 * The two plans are computed over ONE inventory with the shared planner's own
 * platform argument, and the receipt refuses to exist when they disagree:
 * a receipt that named two numbers for one commit would be the very failure
 * it exists to show.
 *
 * @param {object} inputs
 * @param {string} inputs.commit the commit the plan belongs to
 * @param {string} inputs.mergeStamp the commit's merge stamp, YYYYMMDDHHMM
 * @param {string[]} inputs.iosBuilds the iOS builds the plan sees
 * @param {string[]} inputs.macBuilds the macOS builds the plan sees
 * @param {string[]} [inputs.extraFloors] the extra floors the plan sees
 * @param {string} [inputs.marketingVersion] the marketing version of the plan
 * @param {string} [inputs.commitKind] where the commit identity came from
 * @param {string} [inputs.inventoryKind] where the inventory came from
 */
export function planReceipt({
  commit,
  mergeStamp,
  iosBuilds = [],
  macBuilds = [],
  extraFloors = [],
  marketingVersion = DEFAULT_MARKETING_VERSION,
  commitKind = "synthetic",
  inventoryKind = "synthetic",
} = {}) {
  const stamp = String(mergeStamp ?? "");
  if (!/^[1-9][0-9]{11}$/.test(stamp)) {
    throw new Error(`merge stamp must be a 12-digit YYYYMMDDHHMM string: ${stamp}`);
  }
  const plan = { complete: true, mergeStamp: stamp, extraFloors };
  const ios = nextSharedBuild({ ...plan, iosBuilds, macBuilds, platform: "ios" });
  const macos = nextSharedBuild({ ...plan, iosBuilds, macBuilds, platform: "macos" });
  if (ios.build !== macos.build) {
    throw new Error(
      `the iOS plan (${ios.build}) and the Mac plan (${macos.build}) of one commit disagree`,
    );
  }
  return {
    schema: RECEIPT_SCHEMA,
    kind: RECEIPT_KIND,
    fixture: true,
    hostedProof: false,
    notice:
      "This receipt is a synthetic fixture.\u00A0 It is produced offline over a synthetic inventory, and it is not proof that a hosted job ran.",
    commit: String(commit ?? ""),
    commitKind,
    mergeStamp: stamp,
    marketingVersion: String(marketingVersion),
    sharedBuild: ios.build,
    inventory: {
      kind: inventoryKind,
      iosBuilds: [...iosBuilds],
      macBuilds: [...macBuilds],
      extraFloors: [...extraFloors],
    },
    plans: {
      ios: {
        platform: "ios",
        build: ios.build,
        planner: "scripts/ios-fleet/shared-build.mjs nextSharedBuild(platform: ios)",
      },
      macos: {
        platform: "macos",
        build: macos.build,
        planner: "scripts/ios-fleet/shared-build.mjs nextSharedBuild(platform: macos)",
      },
    },
    credentials: PLANNER_CREDENTIALS.map((row) => ({ ...row, value: REDACTED_VALUE })),
  };
}

/**
 * The arguments this producer takes.
 *
 * Nothing here names a secret and nothing here is read from the
 * environment: the producer's inputs are its own arguments, so the
 * receipt it writes cannot carry a value the environment happened to hold.
 */
export function parseArgs(argv) {
  const args = { out: "", repoRoot: "", sha: "HEAD", commit: "", stamp: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = () => {
      index += 1;
      return argv[index] ?? "";
    };
    if (arg === "--out") args.out = take();
    else if (arg === "--repo-root") args.repoRoot = take();
    else if (arg === "--sha") args.sha = take();
    else if (arg === "--commit") args.commit = take();
    else if (arg === "--stamp") args.stamp = take();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * The commit and the merge stamp the receipt is about.
 *
 * A named commit and stamp are taken as they are, a checkout is read with
 * git, and neither leaves the fixture's own synthetic identity.
 */
export function inputsFor(args) {
  if (args.commit !== "" || args.stamp !== "") {
    return {
      commit: args.commit === "" ? FIXTURE_COMMIT : args.commit,
      mergeStamp: args.stamp === "" ? FIXTURE_MERGE_STAMP : args.stamp,
      commitKind: "named",
    };
  }
  if (args.repoRoot !== "") {
    const sha = execFileSync("git", ["-C", args.repoRoot, "rev-parse", args.sha], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return {
      commit: sha,
      mergeStamp: mergeStampFor(committerDateFor(args.repoRoot, args.sha)),
      commitKind: "checkout",
    };
  }
  return {
    commit: FIXTURE_COMMIT,
    mergeStamp: FIXTURE_MERGE_STAMP,
    commitKind: "synthetic",
  };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const inputs = inputsFor(args);
    const receipt = planReceipt({
      ...inputs,
      ...FIXTURE_INVENTORY,
    });
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (args.out === "") process.stdout.write(text);
    else writeFileSync(args.out, text);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
