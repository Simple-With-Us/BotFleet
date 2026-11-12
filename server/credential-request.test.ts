import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_TARGET_SPECS,
  CREDENTIAL_TARGETS,
  credentialConfigPatch,
  credentialIsConfigured,
  credentialResumeOutcome,
  isReusableCredentialRequest,
  isCredentialTargetId,
  type CredentialConfig,
  type CredentialTargetId,
} from "../shared/credential-request.ts";
import { SECRET_FIELDS } from "./secret-map.ts";

const MAPPINGS: Array<[CredentialTargetId, CredentialConfig]> = [
  ["xaiApiKey", { xai: { key: "secret" } }],
  ["deepseekApiKey", { deepseek: { key: "secret" } }],
  ["boxToken", { box: { token: "secret" } }],
  ["opencodeGoApiKey", { opencodeGo: { apiKey: "secret" } }],
  ["ttsKey", { tts: { key: "secret", provider: "minimax" } }],
  ["openaiImageApiKey", { imageGen: { key: "secret" } }],
];

describe("credential request allowlist", () => {
  it("accepts only declared own ids", () => {
    expect(isCredentialTargetId("xaiApiKey")).toBe(true);
    expect(isCredentialTargetId("deepseekApiKey")).toBe(true);
    expect(isCredentialTargetId("composioApiKey")).toBe(false);
    expect(isCredentialTargetId("__proto__")).toBe(false);
    expect(isCredentialTargetId({ toString: () => "xaiApiKey" })).toBe(false);
  });

  it("maps each id to a fixed config location", () => {
    expect(MAPPINGS.map(([id]) => id).sort()).toEqual(Object.keys(CREDENTIAL_TARGETS).sort());
    for (const [id, patch] of MAPPINGS) {
      expect(credentialConfigPatch(id, "secret")).toEqual(patch);
      expect(credentialIsConfigured(patch, id)).toBe(true);
      expect(credentialIsConfigured({}, id)).toBe(false);
    }
  });

  it("checks configured state without exposing values", () => {
    expect(credentialIsConfigured({ tts: { key: "secret" } }, "ttsKey")).toBe(true);
    expect(credentialIsConfigured({ tts: { key: "" } }, "ttsKey")).toBe(false);
    expect(Object.keys(CREDENTIAL_TARGETS)).toHaveLength(6);
  });

  it("reuses open room cards only for the bot that requested them", () => {
    const card = {
      kind: "secret",
      secret: { target: "xaiApiKey" },
      from: { botId: "atlas" },
    };
    expect(isReusableCredentialRequest(card, "xaiApiKey", "atlas", true)).toBe(true);
    expect(isReusableCredentialRequest(card, "xaiApiKey", "pixel", true)).toBe(false);
    expect(isReusableCredentialRequest(card, "xaiApiKey", "pixel", false)).toBe(true);
    expect(isReusableCredentialRequest({ ...card, secret: { ...card.secret, provided: true } }, "xaiApiKey", "atlas", true)).toBe(false);
  });

  it("derives every target from one spec row tied to the server registry (BF-2437)", () => {
    const byId = new Map(SECRET_FIELDS.map((field) => [field.id, field]));
    for (const [id, spec] of Object.entries(CREDENTIAL_TARGET_SPECS)) {
      if (!isCredentialTargetId(id)) throw new Error(`spec key is not a target id: ${id}`);
      expect(CREDENTIAL_TARGETS[id].label).toBe(spec.label);
      const field = byId.get(spec.secretFieldId);
      expect(field, `${id} -> ${spec.secretFieldId}`).toBeDefined();
      expect(field?.secret).toBe(true);
      expect(spec.configPath.join(".")).toBe(spec.secretFieldId);
    }
  });

  it("keeps patch and isConfigured in step with configPath (BF-2437)", () => {
    for (const [id, spec] of Object.entries(CREDENTIAL_TARGET_SPECS)) {
      if (!isCredentialTargetId(id)) throw new Error(`spec key is not a target id: ${id}`);
      // The saved patch lands the value at exactly spec.configPath.
      const patch = credentialConfigPatch(id, "secret");
      expect(patch, `${id} patch`).toHaveProperty([...spec.configPath], "secret");
      // The configured check reads that same leaf: blank it and the card is unconfigured again.
      expect(credentialIsConfigured(patch, id), `${id} configured after save`).toBe(true);
      const blanked: CredentialConfig = JSON.parse(JSON.stringify(patch).replace('"secret"', '""'));
      expect(credentialIsConfigured(blanked, id), `${id} configured with blank ${spec.configPath.join(".")}`).toBe(false);
    }
  });

  it("preserves the original save or decline outcome when retrying", () => {
    expect(credentialResumeOutcome({ provided: true })).toBe("provided");
    expect(credentialResumeOutcome({ dismissed: true })).toBe("dismissed");
    expect(credentialResumeOutcome({})).toBeNull();
    expect(credentialResumeOutcome({ provided: true, dismissed: true })).toBeNull();
  });
});
