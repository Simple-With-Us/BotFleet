import { afterEach, describe, expect, it, vi } from "vitest";

import { InfisicalError, listSecrets, login, upsertSecret, verifyServiceToken } from "./infisical-client.ts";

// Obviously fake, and never sent anywhere real: these exist so the
// assertions below have a credential-shaped string to look for. Every test
// that could plausibly leak one asserts it is absent from what came back.
const SENTINEL_CLIENT_SECRET = "sentinel-client-secret-not-real";
const SENTINEL_TOKEN = "sentinel-bearer-token-not-real";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyServiceToken", () => {
  const options = { siteUrl: "https://app.infisical.example", token: SENTINEL_TOKEN,
    projectId: "proj-1", environment: "prod", secretPath: "/folder", mode: "read" as const };
  const metadata = { workspace: "proj-1", projectId: "proj-1", scopes: [{ environment: "prod", secretPath: "/folder/" }], permissions: ["read"], expiresAt: null };
  const malformedFolders = ["//", "///", "/./", "/../", "/fleet/../", "/fleet/./vercel",
    "/fleet//vercel", "/fleet/vercel//", "/fleet/.", "/fleet/.."];

  it("verifies flat metadata with exact project, role and normalized folder and returns only expiry", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.infisical.example/api/v2/service-token");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SENTINEL_TOKEN}`);
      return new Response(JSON.stringify({ ...metadata, secretHash: SENTINEL_CLIENT_SECRET }));
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyServiceToken(options)).toEqual({ expiresAt: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts the serialized scopes array stored by the upstream service-token handler", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata, scopes: JSON.stringify(metadata.scopes) }))));
    expect(await verifyServiceToken(options)).toEqual({ expiresAt: null });
  });

  it.each([
    "http://vault.example.test", "ftp://vault.example.test", "vault.example.test",
    "https:", "https://", "https:///vault.example.test", "https:vault.example.test",
    "https:/vault.example.test", "https://user@vault.example.test", "https://user:password@vault.example.test",
    "https://@vault.example.test", "https://vault.example.test?mode=unsafe", "https://vault.example.test?",
    "https://vault.example.test#fragment", "https://vault.example.test#", "https://vault.example.test\\other",
    " https://vault.example.test", "https://vault.example.test ",
  ])("refuses unsafe site %s before sending any bearer request", async (siteUrl) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(metadata)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyServiceToken({ ...options, siteUrl })).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a secure custom endpoint with a port, base path and unrelated vendor fields", async () => {
    const siteUrl = "https://vault.example.test:8443/infisical";
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${siteUrl}/api/v2/service-token`);
      return new Response(JSON.stringify({ ...metadata, futureVendorMetadata: { enabled: true },
        scopes: [{ ...metadata.scopes[0], futureVendorScope: "accepted" }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyServiceToken({ ...options, siteUrl })).toEqual({ expiresAt: null });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([...malformedFolders, ...["*", "?", "[", "]", "{", "}"].map((character) => `/folder/${character}`)])
  ("rejects matching nonliteral request and grant %s before any secret access", async (secretPath) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ...metadata,
      scopes: [{ environment: "prod", secretPath }],
    })));
    vi.stubGlobal("fetch", fetchMock);
    for (const mode of ["read", "write"] as const) {
      const accessSecrets = async () => {
        await verifyServiceToken({ ...options, secretPath, mode });
        if (mode === "read") await listSecrets({ ...options, secretPath, viewValues: false });
        else await upsertSecret({ ...options, secretPath, name: "FIXTURE", value: "fixture-value" });
      };
      await expect(accessSecrets()).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([...malformedFolders, ...["*", "?", "[", "]", "{", "}"].map((character) => `/other/${character}`)])
  ("rejects nonliteral metadata row %s even alongside a valid exact grant", async (secretPath) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ ...metadata,
        scopes: [...metadata.scopes, { environment: "staging", secretPath }],
      }));
    }));
    const accessSecrets = async () => {
      await verifyServiceToken(options);
      await listSecrets({ ...options, viewValues: false });
    };
    await expect(accessSecrets()).rejects.toMatchObject({ statusCode: 502 });
    expect(calls).toEqual(["https://app.infisical.example/api/v2/service-token"]);
  });

  it.each(["/", "/folder", "/folder/", "/folder/.hidden/v1..2", "/folder/%2e%2e"])
  ("accepts canonical literal folder %s without decoding its segments", async (secretPath) => {
    const grantedPath = secretPath.replace(/\/$/, "") || "/";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata,
      scopes: [{ environment: "prod", secretPath: grantedPath }],
    }))));
    expect(await verifyServiceToken({ ...options, secretPath })).toEqual({ expiresAt: null });
  });

  it("accepts literal folders with spaces and ordinary punctuation", async () => {
    const secretPath = "/folder with spaces/(copy)+@!#%&=,;:._-";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata,
      scopes: [{ environment: "prod", secretPath: `${secretPath}/` }],
    }))));
    expect(await verifyServiceToken({ ...options, secretPath })).toEqual({ expiresAt: null });
  });

  it.each([
    { workspace: "another-project" }, { projectId: "another-project" },
    { scopes: [{ environment: "staging", secretPath: "/folder" }] },
    { scopes: [{ environment: "prod", secretPath: "/" }] },
    { scopes: [{ environment: "prod", secretPath: "/folder/child" }] },
    { scopes: [{ environment: "prod", secretPath: "/folder/*" }] },
    { permissions: ["read", "write"] }, { permissions: ["write"] },
    { expiresAt: "2000-01-01T00:00:00Z" },
  ])("refuses mismatched scope, permission or expiry %#", async (patch) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata, ...patch }))));
    await expect(verifyServiceToken(options)).rejects.toBeInstanceOf(InfisicalError);
  });

  it.each([
    null, [], { serviceToken: metadata }, { ...metadata, workspace: {} },
    { ...metadata, scopes: "prod" }, { ...metadata, scopes: [null] },
    { ...metadata, scopes: "{}" }, { ...metadata, scopes: "null" },
    { ...metadata, scopes: "[null]" }, { ...metadata, scopes: "123" }, { ...metadata, scopes: [] },
    { ...metadata, scopes: [{ environment: "", secretPath: "/folder" }] },
    { ...metadata, scopes: [{ environment: 123, secretPath: "/folder" }] },
    { ...metadata, scopes: JSON.stringify({ scopes: metadata.scopes }) },
    { ...metadata, scopes: [{ environment: "prod", secretPath: 1 }] },
    { ...metadata, permissions: "read" }, { ...metadata, permissions: ["read", "admin"] },
    { ...metadata, expiresAt: undefined }, { ...metadata, expiresAt: 123 }, { ...metadata, expiresAt: "not-a-date" },
    { ...metadata, expiresAt: "2999-02-30T00:00:00Z" },
    { ...metadata, expiresAt: true }, { ...metadata, workspace: " " },
  ])("fails closed for malformed flat metadata %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(verifyServiceToken(options)).rejects.toMatchObject({ statusCode: 502 });
  });

  it.each([["write"], ["read", "write"]])("permits a dedicated write credential with permissions %j", async (...permissions) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...metadata, permissions }))));
    expect(await verifyServiceToken({ ...options, mode: "write" })).toEqual({ expiresAt: null });
  });

  it("refuses read-only credentials for writes and never logs an upstream body or transport message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(metadata))));
    await expect(verifyServiceToken({ ...options, mode: "write" })).rejects.toMatchObject({ statusCode: 403 });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(SENTINEL_TOKEN); }));
    await expect(verifyServiceToken(options)).rejects.not.toThrow(SENTINEL_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SENTINEL_TOKEN, { status: 403 })));
    await expect(verifyServiceToken(options)).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyServiceToken(options)).rejects.not.toThrow(SENTINEL_TOKEN);
  });
});

describe("login", () => {
  it("posts clientId and clientSecret to the universal-auth path and returns only the token", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.infisical.example/api/v1/auth/universal-auth/login");
      expect(init?.method).toBe("POST");
      // SAFETY: this suite's own call under test built the body, so its
      // shape is exactly the two fields asserted immediately below.
      const body = JSON.parse(String(init?.body)) as { clientId: string; clientSecret: string };
      expect(body).toEqual({ clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET });
      return new Response(
        JSON.stringify({ accessToken: SENTINEL_TOKEN, expiresIn: 900, tokenType: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await login({
      siteUrl: "https://app.infisical.example",
      clientId: "client-1",
      clientSecret: SENTINEL_CLIENT_SECRET,
    });

    expect(token).toBe(SENTINEL_TOKEN);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws an InfisicalError carrying the status and no body detail on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: `bad credentials ${SENTINEL_CLIENT_SECRET}` }), { status: 401 })),
    );

    let caught: unknown;
    try {
      await login({ siteUrl: "https://app.infisical.example", clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(401);
      expect(caught.message).not.toContain(SENTINEL_CLIENT_SECRET);
      expect(caught.message).toMatch(/401/);
    }
  });

  it("refuses a response with no accessToken", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));

    await expect(
      login({ siteUrl: "https://app.infisical.example", clientId: "client-1", clientSecret: SENTINEL_CLIENT_SECRET }),
    ).rejects.toThrow(/no accessToken/);
  });
});

describe("listSecrets", () => {
  it("builds the exact query, including viewSecretValue=false, when probing", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/api/v3/secrets/raw");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        workspaceId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewSecretValue: "false",
        expandSecretReferences: "false",
        include_imports: "false",
      });
      // SAFETY: this suite's own call built the headers as a plain record.
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${SENTINEL_TOKEN}`);
      return new Response(
        JSON.stringify({ secrets: [{ secretKey: "COMPOSIO_API_KEY", secretValue: "should-not-appear" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listSecrets({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      viewValues: false,
    });

    expect(result.names).toEqual(["COMPOSIO_API_KEY"]);
    expect(result.values.size).toBe(0);
  });

  it("populates values only when viewValues is true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              secrets: [
                { secretKey: "COMPOSIO_API_KEY", secretValue: "real-value" },
                { secretKey: "PATH", secretValue: "/usr/bin" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await listSecrets({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      viewValues: true,
    });

    expect(result.names).toEqual(["COMPOSIO_API_KEY", "PATH"]);
    expect(result.values.get("COMPOSIO_API_KEY")).toBe("real-value");
    expect(result.values.get("PATH")).toBe("/usr/bin");
  });

  it("throws an InfisicalError on a non-2xx list response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: true,
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe("upsertSecret", () => {
  it("PATCHes the raw secret and returns on success", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.infisical.example/api/v3/secrets/raw/COMPOSIO_API_KEY");
      expect(init?.method).toBe("PATCH");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ workspaceId: "proj-1", environment: "prod", secretPath: "/", secretValue: "new-value" });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSecret({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      name: "COMPOSIO_API_KEY",
      value: "new-value",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to POST with type shared when the PATCH 404s", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.method));
      if (init?.method === "PATCH") return new Response("not found", { status: 404 });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        workspaceId: "proj-1",
        environment: "prod",
        secretPath: "/",
        secretValue: "new-value",
        type: "shared",
      });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSecret({
      siteUrl: "https://app.infisical.example",
      token: SENTINEL_TOKEN,
      projectId: "proj-1",
      environment: "prod",
      secretPath: "/",
      name: "COMPOSIO_API_KEY",
      value: "new-value",
    });

    expect(calls).toEqual(["PATCH", "POST"]);
  });

  it("throws when both the PATCH and the fallback POST fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH" ? new Response("nope", { status: 404 }) : new Response("nope", { status: 500 }),
      ),
    );

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("throws immediately on a non-404 PATCH failure, without a fallback POST", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("network failures and timeouts", () => {
  it("wraps fetch timeout in InfisicalError with 504 and phase context", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    let caught: unknown;
    try {
      await login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
        timeoutMs: 5000,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(504);
      expect(caught.message).toBe("Infisical login timed out after 5000 ms");
    }
  });

  it("wraps listSecrets timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: false,
        timeoutMs: 2500,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical secrets list timed out after 2500 ms",
    });
  });

  it("wraps upsertSecret timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw timeoutErr;
      }),
    );

    await expect(
      upsertSecret({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        name: "COMPOSIO_API_KEY",
        value: "new-value",
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical secret update timed out after 3000 ms",
    });
  });

  it("wraps general network failure in InfisicalError with 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(
      login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 502,
      message: "Infisical login failed: fetch failed",
    });
  });

  it("wraps listSecrets body streaming timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw timeoutErr;
        },
      } as unknown as Response)),
    );

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: true,
        timeoutMs: 4000,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical secrets list timed out after 4000 ms",
    });
  });

  it("throws 502 when listSecrets body has no secrets array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ notSecrets: [] }), { status: 200 })),
    );

    await expect(
      listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: true,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 502,
      message: "Infisical secrets list response carried no secrets array",
    });
  });

  it("wraps login body streaming timeout in InfisicalError with 504", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw timeoutErr;
        },
      } as unknown as Response)),
    );

    await expect(
      login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
        timeoutMs: 4500,
      }),
    ).rejects.toMatchObject({
      name: "InfisicalError",
      statusCode: 504,
      message: "Infisical login timed out after 4500 ms",
    });
  });

  it("discards JSON parser excerpts and secret snippets on malformed listSecrets response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token 'x' in JSON at position 10: "${SENTINEL_TOKEN}"`);
        },
      } as unknown as Response)),
    );

    let caught: unknown;
    try {
      await listSecrets({
        siteUrl: "https://app.infisical.example",
        token: SENTINEL_TOKEN,
        projectId: "proj-1",
        environment: "prod",
        secretPath: "/",
        viewValues: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(502);
      expect(caught.message).toBe("Infisical secrets list failed: invalid response body");
      expect(caught.message).not.toContain(SENTINEL_TOKEN);
    }
  });

  it("discards JSON parser excerpts on malformed login response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token 'x' in JSON at position 10: "${SENTINEL_CLIENT_SECRET}"`);
        },
      } as unknown as Response)),
    );

    let caught: unknown;
    try {
      await login({
        siteUrl: "https://app.infisical.example",
        clientId: "client-1",
        clientSecret: SENTINEL_CLIENT_SECRET,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InfisicalError);
    if (caught instanceof InfisicalError) {
      expect(caught.statusCode).toBe(502);
      expect(caught.message).toBe("Infisical login failed: invalid response body");
      expect(caught.message).not.toContain(SENTINEL_CLIENT_SECRET);
    }
  });
});


