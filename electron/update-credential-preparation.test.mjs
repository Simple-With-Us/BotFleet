import { describe, expect, it } from "vitest";

import {
  createUpdateCredentialReceipt,
  updateCredentialReceiptPath,
  validUpdateCredentialReceipt,
} from "./update-credential-preparation.mjs";

describe("update credential preparation", () => {
  it("accepts one private stage receipt path and rejects ambiguous or relative paths", () => {
    expect(updateCredentialReceiptPath(["BotFleet"])).toBeNull();
    expect(updateCredentialReceiptPath(["BotFleet", "--prepare-update-credentials=/private/stage/credential-migration.json"]))
      .toBe("/private/stage/credential-migration.json");
    expect(() => updateCredentialReceiptPath(["--prepare-update-credentials=credential-migration.json"]))
      .toThrow(/unsafe/);
    expect(() => updateCredentialReceiptPath([
      "--prepare-update-credentials=/a/credential-migration.json",
      "--prepare-update-credentials=/b/credential-migration.json",
    ])).toThrow(/Exactly one/);
  });

  it("binds a durable marker receipt to the clean candidate source", () => {
    const sourceCommit = "b".repeat(40);
    const receipt = createUpdateCredentialReceipt({ app: "botfleet", sourceDirty: false, sourceCommit }, [
      "xaiApiKey", "custom.engine", "xaiApiKey",
    ]);
    expect(receipt.markerNames).toEqual(["custom.engine", "xaiApiKey"]);
    expect(validUpdateCredentialReceipt(receipt, sourceCommit)).toBe(true);
    expect(validUpdateCredentialReceipt(receipt, "c".repeat(40))).toBe(false);
    expect(() => createUpdateCredentialReceipt({ app: "botfleet", sourceDirty: true, sourceCommit }, []))
      .toThrow(/exact clean/);
  });
});
