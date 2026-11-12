import { describe, expect, it } from "vitest";
import {
  resolveChatCompletionsCredentials,
  type ResolveChatCompletionsCredentialsInput,
} from "./credentials.ts";

const RESERVED = "minimax";
const ENV = "MINIMAX_API_KEY";

function call(override: Partial<ResolveChatCompletionsCredentialsInput> = {}): {
  apiKey: string;
  fromWorkspace: boolean;
} {
  return resolveChatCompletionsCredentials({
    environment: {},
    envKeyEnv: ENV,
    reservedInstanceId: RESERVED,
    instanceId: RESERVED,
    ...override,
  });
}

describe("resolveChatCompletionsCredentials", () => {
  describe("reserved instance", () => {
    it("prefers the instance's own environment over process.env", () => {
      const prev = process.env[ENV];
      process.env[ENV] = "env-from-process";
      try {
        const out = call({ environment: { [ENV]: "env-from-instance" } });
        expect(out.apiKey).toBe("env-from-instance");
        expect(out.fromWorkspace).toBe(false);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });

    it("falls back to process.env when the instance environment is empty", () => {
      const prev = process.env[ENV];
      process.env[ENV] = "env-from-process";
      try {
        const out = call();
        expect(out.apiKey).toBe("env-from-process");
        expect(out.fromWorkspace).toBe(true);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });

    it("falls back to local config when neither instance env nor process.env are set", () => {
      const prev = process.env[ENV];
      delete process.env[ENV];
      try {
        const out = call({ localConfigKey: { apiKey: "local-key" } });
        expect(out.apiKey).toBe("local-key");
        expect(out.fromWorkspace).toBe(true);
      } finally {
        if (prev !== undefined) process.env[ENV] = prev;
      }
    });

    it("prefers process.env over local config when the env var is set", () => {
      const prev = process.env[ENV];
      process.env[ENV] = "env-from-process";
      try {
        const out = call({ localConfigKey: { apiKey: "local-key" } });
        expect(out.apiKey).toBe("env-from-process");
        expect(out.fromWorkspace).toBe(true);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });

    it("skips whitespace-only instance environment values rather than masking a real key", () => {
      const prev = process.env[ENV];
      process.env[ENV] = "env-from-process";
      try {
        const out = call({ environment: { [ENV]: "   " } });
        expect(out.apiKey).toBe("env-from-process");
        expect(out.fromWorkspace).toBe(true);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });

    it("returns an empty apiKey on the reserved instance when every source is empty", () => {
      const prev = process.env[ENV];
      delete process.env[ENV];
      try {
        const out = call();
        expect(out.apiKey).toBe("");
        expect(out.fromWorkspace).toBe(false);
      } finally {
        if (prev !== undefined) process.env[ENV] = prev;
      }
    });
  });

  describe("non-reserved instance", () => {
    it("returns an empty apiKey when only process.env is set", () => {
      const prev = process.env[ENV];
      process.env[ENV] = "env-from-process";
      try {
        const out = call({ instanceId: "minimax-global" });
        expect(out.apiKey).toBe("");
        expect(out.fromWorkspace).toBe(false);
      } finally {
        if (prev === undefined) delete process.env[ENV];
        else process.env[ENV] = prev;
      }
    });

    it("returns an empty apiKey when only localConfigKey is set", () => {
      const out = call({ instanceId: "minimax-global", localConfigKey: { apiKey: "local-key" } });
      expect(out.apiKey).toBe("");
      expect(out.fromWorkspace).toBe(false);
    });

    it("uses the instance environment when it carries a key", () => {
      const out = call({
        instanceId: "minimax-global",
        environment: { [ENV]: "instance-key" },
      });
      expect(out.apiKey).toBe("instance-key");
      expect(out.fromWorkspace).toBe(false);
    });
  });
});
