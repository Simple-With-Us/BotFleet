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
      expect(CREDENTIAL_TARGETS[id as CredentialTargetId].label).toBe(spec.label);
      const field = byId.get(spec.secretFieldId);
      expect(field, `${id} -> ${spec.secretFieldId}`).toBeDefined();
      expect(field?.secret).toBe(true);
      expect(spec.configPath.join(".")).toBe(spec.secretFieldId);
    }
  });

  it("preserves the original save or decline outcome when retrying", () => {
    expect(credentialResumeOutcome({ provided: true })).toBe("provided");
    expect(credentialResumeOutcome({ dismissed: true })).toBe("dismissed");
    expect(credentialResumeOutcome({})).toBeNull();
    expect(credentialResumeOutcome({ provided: true, dismissed: true })).toBeNull();
  });
});
