import { describe, expect, it } from "vitest";

import {
  arrivedViaCloudflareTunnel,
  isMutatingHarnessApiRequest,
  NAMED_TUNNEL_MUTATION_FORBIDDEN,
} from "./named-tunnel-gate.ts";

const req = (headers: Record<string, string | string[]>) => ({ headers });

describe("named-tunnel-gate", () => {
  it("detects Cloudflare tunnel markers on the request", () => {
    expect(arrivedViaCloudflareTunnel(req({}))).toBe(false);
    expect(arrivedViaCloudflareTunnel(req({ host: "127.0.0.1:8799" }))).toBe(false);
    expect(arrivedViaCloudflareTunnel(req({ "cf-ray": "abc" }))).toBe(true);
    expect(arrivedViaCloudflareTunnel(req({ "cf-connecting-ip": "203.0.113.1" }))).toBe(true);
    expect(arrivedViaCloudflareTunnel(req({ "cf-access-jwt-assertion": "eyJ.fixture" }))).toBe(true);
    expect(arrivedViaCloudflareTunnel(req({ "cf-ray": [""] }))).toBe(false);
  });

  it("classifies mutating harness API routes", () => {
    expect(isMutatingHarnessApiRequest("GET", "/api/health")).toBe(false);
    expect(isMutatingHarnessApiRequest("POST", "/api/bots")).toBe(true);
    expect(isMutatingHarnessApiRequest("PUT", "/api/config")).toBe(true);
    expect(isMutatingHarnessApiRequest("POST", "/api/runtime/quiesce")).toBe(false);
  });

  it("exports stable mutation refusal copy", () => {
    expect(NAMED_TUNNEL_MUTATION_FORBIDDEN).toContain("named tunnel");
  });

  it("treats mutating API plus tunnel markers as blocked at the gate", () => {
    const mutating = isMutatingHarnessApiRequest("POST", "/api/bots");
    const tunneled = arrivedViaCloudflareTunnel({ headers: { "cf-ray": "fixture-ray" } });
    expect(mutating && tunneled).toBe(true);
  });
});
