import { dirname, isAbsolute, basename } from "node:path";

export const UPDATE_CREDENTIAL_RECEIPT_SCHEMA = 1;
const FLAG = "--prepare-update-credentials=";

export function updateCredentialReceiptPath(argv) {
  const matches = (argv ?? []).filter((arg) => typeof arg === "string" && arg.startsWith(FLAG));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("Exactly one update credential receipt path is required");
  const value = matches[0].slice(FLAG.length);
  if (!isAbsolute(value) || basename(value) !== "credential-migration.json" || dirname(value) === "/") {
    throw new Error("Update credential receipt path is unsafe");
  }
  return value;
}

export function createUpdateCredentialReceipt(build, markerNames) {
  if (build?.app !== "botfleet" || build?.sourceDirty !== false ||
      typeof build.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(build.sourceCommit)) {
    throw new Error("Update credential preparation requires an exact clean BotFleet build");
  }
  const names = [...new Set(markerNames ?? [])].sort();
  if (names.some((name) => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))) {
    throw new Error("Update credential marker receipt is invalid");
  }
  return {
    schemaVersion: UPDATE_CREDENTIAL_RECEIPT_SCHEMA,
    app: "botfleet",
    status: "prepared",
    sourceCommit: build.sourceCommit,
    durableMarkers: true,
    markerNames: names,
  };
}

export function validUpdateCredentialReceipt(value, expectedCommit) {
  return value?.schemaVersion === UPDATE_CREDENTIAL_RECEIPT_SCHEMA && value?.app === "botfleet" &&
    value?.status === "prepared" && value?.sourceCommit === expectedCommit &&
    /^[a-f0-9]{40}$/.test(value?.sourceCommit ?? "") && value?.durableMarkers === true &&
    Array.isArray(value?.markerNames) && value.markerNames.every(
      (name) => typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name),
    );
}
