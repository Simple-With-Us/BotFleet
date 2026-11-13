// Cloudflare Access is the reason a healthy recall service can look dead:
// it answers an unauthenticated request with a redirect to a login page and
// ignores a bearer credential outright.  These tests pin the two halves of
// the fix — send the service-token header pair, and recognise the redirect.
import { describe, expect, it } from "vitest";

import { accessHeaders, accessLoginHint, accessTokenState, hasAccessServiceToken, type ProbedResponse } from "./recall-access.ts";

/** A response double: only the four fields the hint reads. */
function response(init: {
  status: number;
  redirected?: boolean;
  url?: string;
  headers?: Record<string, string>;
}): ProbedResponse {
  const headers = init.headers ?? {};
  return {
    status: init.status,
    redirected: init.redirected,
    url: init.url,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

describe("accessHeaders", () => {
  it("emits the pair Cloudflare Access reads when both halves are set", () => {
    expect(accessHeaders("client.access", "shhh")).toEqual({
      "CF-Access-Client-Id": "client.access",
      "CF-Access-Client-Secret": "shhh",
    });
    expect(hasAccessServiceToken("client.access", "shhh")).toBe(true);
  });

  it("emits nothing at all when either half is missing or blank", () => {
    // Half a service token is not a credential — sending a lone id would
    // only make the gateway's rejection harder to read.
    expect(accessHeaders("client.access", "")).toEqual({});
    expect(accessHeaders("", "shhh")).toEqual({});
    expect(accessHeaders(undefined, undefined)).toEqual({});
    expect(accessHeaders("  ", " ")).toEqual({});
    expect(hasAccessServiceToken("client.access", "")).toBe(false);
  });

  it("trims surrounding whitespace, which is how a pasted token arrives", () => {
    expect(accessHeaders(" client.access\n", " shhh ")).toEqual({
      "CF-Access-Client-Id": "client.access",
      "CF-Access-Client-Secret": "shhh",
    });
  });
});

describe("accessTokenState", () => {
  // Half a pair is the silent case: `accessHeaders` sends both halves or
  // neither, so a stored secret with an empty id sends no Access headers at
  // all and the service answers a login page that reads like an outage.
  // Yes-or-no cannot say that; this can, and it says which half is missing.
  it("separates a whole pair, no pair, and each half of one", () => {
    expect(accessTokenState("client.access", "shhh")).toBe("complete");
    expect(accessTokenState("", "")).toBe("none");
    expect(accessTokenState(undefined, null)).toBe("none");
    expect(accessTokenState("", "shhh")).toBe("missing-id");
    expect(accessTokenState("client.access", "")).toBe("missing-secret");
  });

  it("treats whitespace as empty, the same way the header builder does", () => {
    expect(accessTokenState("  ", "shhh")).toBe("missing-id");
    expect(accessTokenState("client.access", "\n")).toBe("missing-secret");
    expect(accessTokenState(" ", " ")).toBe("none");
  });

  it("agrees with hasAccessServiceToken about what counts as configured", () => {
    for (const pair of [["a.access", "s"], ["", "s"], ["a.access", ""], ["", ""]] as const) {
      expect(hasAccessServiceToken(...pair)).toBe(accessTokenState(...pair) === "complete");
    }
  });
});

describe("accessLoginHint", () => {
  it("names Access on an unfollowed redirect to a login page", () => {
    const hint = accessLoginHint(
      response({
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/recall.example.com?kid=abc" },
      }),
    );
    expect(hint).toContain("login page");
    expect(hint).toContain("team.cloudflareaccess.com");
    expect(hint).toContain("Cloudflare Access");
    expect(hint).toContain("service token");
  });

  it("keeps the login URL's query string out of the message", () => {
    // An Access login URL carries the original request — and whatever was in
    // it — in redirect_url.  Only the host is ever safe to echo back.
    const hint = accessLoginHint(
      response({
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x?redirect_url=%2Frecall%2Fstats&kid=secret-kid" },
      }),
    );
    expect(hint).not.toContain("secret-kid");
    expect(hint).not.toContain("redirect_url");
  });

  it("still names a gateway for a redirect that is not obviously Cloudflare", () => {
    const hint = accessLoginHint(response({ status: 303, headers: { location: "https://sso.example.com/login" } }));
    expect(hint).toContain("sso.example.com");
    expect(hint).toContain("identity gateway");
  });

  it("catches a redirect that was already followed to an Access host", () => {
    const hint = accessLoginHint(
      response({
        status: 200,
        redirected: true,
        url: "https://team.cloudflareaccess.com/cdn-cgi/access/login/recall.example.com",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(hint).toContain("Cloudflare Access");
  });

  it("catches an HTML page served where a JSON API was asked for", () => {
    const hint = accessLoginHint(
      response({ status: 200, url: "https://recall.example.com/recall/stats", headers: { "content-type": "text/html" } }),
    );
    expect(hint).toContain("login page");
  });

  it("stays quiet for the service's own answers", () => {
    expect(
      accessLoginHint(
        response({ status: 200, url: "https://recall.example.com/health", headers: { "content-type": "application/json" } }),
      ),
    ).toBeNull();
    // A 401 is a service saying no, not a gateway asking who you are — the
    // caller reports that status verbatim instead.
    expect(accessLoginHint(response({ status: 401, headers: { "content-type": "application/json" } }))).toBeNull();
    expect(accessLoginHint(response({ status: 500, headers: { "content-type": "text/html" } }))).toBeNull();
    // A redirect with no Location is not evidence of anything.
    expect(accessLoginHint(response({ status: 302 }))).toBeNull();
  });

  it("stays quiet for a followed redirect that lands back on the same, non-Access host", () => {
    // This is what a `redirect: "follow"` fetch hands back after
    // transparently resolving a same-host http:// -> https:// upgrade (301)
    // or a trailing-slash normalisation (308): by the time accessLoginHint
    // sees the response, the redirect is already gone and this just looks
    // like the service's own 2xx JSON answer.  Only a followed redirect that
    // actually lands on an Access-shaped host or path is worth a word — see
    // "catches a redirect that was already followed to an Access host" above.
    const hint = accessLoginHint(
      response({
        status: 200,
        redirected: true,
        url: "https://recall.example.com/health",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(hint).toBeNull();
  });
});
