// Unit test for the DeepSeek balance fetcher. We don't want to hit the real
// API in tests, so global fetch is stubbed before the module loads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<FetchResponse>>();

function mockResponse(ok: boolean, status: number, body: unknown): FetchResponse {
  return {
    ok,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  // The module captures `fetch` at call time, so stubbing globalThis.fetch
  // before each test is enough.
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  // Reset the module-level cache between tests so different (key, url) pairs
  // don't leak across cases.
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadModule() {
  // Re-import with the current fetch stub in place.
  return await import("./deepseek-balance.ts");
}

describe("getDeepSeekBalance", () => {
  it("returns a 'no key configured' snapshot when the key is empty", async () => {
    const mod = await loadModule();
    const result = await mod.getDeepSeekBalance("", "https://api.deepseek.com");
    expect(result.error).toBe("no key configured");
    expect(result.balanceUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses the USD balance_infos entry and reports availability", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(true, 200, {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "1.00", granted_balance: "1.00", topped_up_balance: "0.00" },
          { currency: "USD", total_balance: "12.34", granted_balance: "10.00", topped_up_balance: "2.34" },
        ],
      }),
    );
    const mod = await loadModule();
    const result = await mod.getDeepSeekBalance("sk-test", "https://api.deepseek.com");
    expect(result.error).toBeNull();
    expect(result.balanceUsd).toBeCloseTo(12.34);
    expect(result.grantedUsd).toBeCloseTo(10);
    expect(result.toppedUpUsd).toBeCloseTo(2.34);
    expect(result.availability).toBe("available");
  });

  it("returns an error snapshot on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(false, 401, null));
    const mod = await loadModule();
    const result = await mod.getDeepSeekBalance("sk-bad", "https://api.deepseek.com");
    expect(result.error).toBe("HTTP 401");
    expect(result.balanceUsd).toBeNull();
  });

  it("normalizes a host without a scheme to https", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { is_available: false, balance_infos: [] }));
    const mod = await loadModule();
    await mod.getDeepSeekBalance("sk-test", "proxy.example.test");
    const calledWith = fetchMock.mock.calls[0][0] as string;
    expect(calledWith.startsWith("https://proxy.example.test/user/balance")).toBe(true);
  });

  it("falls back to 'unknown' when the API does not include is_available or balance_infos", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(true, 200, { unrelated: true }));
    const mod = await loadModule();
    const result = await mod.getDeepSeekBalance("sk-test", "https://api.deepseek.com");
    expect(result.availability).toBe("unknown");
    expect(result.balanceUsd).toBeNull();
  });

  it("times out a hanging fetch instead of blocking /api/quotas forever", async () => {
    vi.useFakeTimers();
    try {
      // Simulates an unresponsive api.deepseek.com: the promise never
      // settles on its own, only when the module's own AbortController
      // fires — proving the 4s timeout, not the mock, ends the call.
      fetchMock.mockImplementationOnce(
        (_input, init) =>
          new Promise<FetchResponse>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const mod = await loadModule();
      const pending = mod.getDeepSeekBalance("sk-test", "https://api.deepseek.com");
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await pending;
      expect(result.error).toBe("timeout");
      expect(result.balanceUsd).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
