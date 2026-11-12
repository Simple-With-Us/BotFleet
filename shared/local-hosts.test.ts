import { describe, expect, it } from "vitest";

import { LOCAL_HOSTS, decodeInjectId as decodeFromServer, encodeInjectId } from "../server/drivers/local-inject.ts";
import { INJECT_SEP, LOCAL_HOST_IDS, decodeInjectId } from "./local-hosts.ts";

describe("local host ids", () => {
  it("match the harness's LOCAL_HOSTS table exactly, so the picker sees every host the harness probes", () => {
    expect([...LOCAL_HOST_IDS].sort()).toEqual(LOCAL_HOSTS.map((host) => host.id).sort());
  });

  it("decodes what the harness encodes, for every host", () => {
    for (const host of LOCAL_HOSTS) {
      const id = encodeInjectId(host.id, "qwen3:8b");
      expect(id).toBe(`${host.id}${INJECT_SEP}qwen3:8b`);
      expect(decodeInjectId(id)).toEqual({ host: host.id, model: "qwen3:8b" });
      expect(decodeFromServer(id)).toEqual(decodeInjectId(id));
    }
  });

  it("refuses anything that is not a known host plus a plain model name", () => {
    expect(decodeInjectId("gpt-5.4")).toBeNull();
    expect(decodeInjectId("ollama")).toBeNull();
    expect(decodeInjectId("::qwen3")).toBeNull();
    expect(decodeInjectId("somewhere::qwen3")).toBeNull();
    expect(decodeInjectId("ollama::")).toBeNull();
    expect(decodeInjectId("ollama:: spaced")).toBeNull();
    expect(decodeInjectId(null)).toBeNull();
    expect(decodeInjectId(undefined)).toBeNull();
  });
});
