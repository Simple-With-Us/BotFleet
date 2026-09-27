// The native log must keep the shape of a session-setup message and lose the
// credential values.  These tests use the exact shapes the drivers actually
// write — the ACP `env: [{name,value}]` wire form and the claude mcpServers
// object form — so a change to either shape breaks the test, not the secret.
import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it("masks the tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: "/Users/someone",
        mcpServers: [
          {
            name: "agents",
            command: "/usr/bin/node",
            args: ["/app/agents-proxy.js"],
            env: [
              { name: "OMB_BOT_ID", value: "bot-123" },
              { name: "OMB_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
          {
            name: "computer",
            command: "/usr/bin/node",
            args: ["/app/computer-proxy.js"],
            env: [
              { name: "OGB_BOX_ID", value: "box-9" },
              { name: "OGB_BOX_TOKEN", value: "box_live_abcdefghijklmnop" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));

    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).not.toContain("box_live_abcdefghijklmnop");
    // shape survives: still the same method, servers, names and non-secret env
    expect(out).toContain("session/new");
    expect(out).toContain("OMB_COMMS_TOKEN");
    expect(out).toContain("OGB_BOX_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("box-9");
    expect(out).toContain("/app/agents-proxy.js");
    // and it says how long the value was, which is what you debug with
    expect(out).toContain("«redacted 24 chars»");
  });

  it("masks a Composio key in an MCP header and an env object", () => {
    const config = {
      mcpServers: {
        composio: {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
          headers: { "x-api-key": "ak_live_supersecret" },
        },
        computer: { env: { ELECTRON_RUN_AS_NODE: "1", OGB_BOX_TOKEN: "box_live_zzz" } },
      },
    };

    const out = flat(redactSecrets(config));
    expect(out).not.toContain("ak_live_supersecret");
    expect(out).not.toContain("box_live_zzz");
    expect(out).toContain("app.composio.dev");
    expect(out).toContain("ELECTRON_RUN_AS_NODE");
    expect(out).toContain('"1"'); // a non-secret value is untouched
  });

  it("still content-redacts an ACP env entry whose name is not secret-shaped", () => {
    // A credential can land under an ordinary-looking variable name (a
    // custom env var, a feature flag someone repurposed) — the ACP
    // {name,value} shortcut must not skip the content pass just because
    // the NAME alone doesn't scream "secret".
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const sessionNew = {
      params: {
        mcpServers: [
          {
            name: "custom",
            env: [
              { name: "SESSION_CONFIG", value: leaked },
              { name: "FEATURE_FLAG", value: "enabled" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain(leaked);
    expect(out).toContain("SESSION_CONFIG");
    expect(out).toContain("FEATURE_FLAG");
    expect(out).toContain("enabled");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });

  it("does not mangle words that merely contain 'key'", () => {
    const msg = { keyboard: "cmd+k", monkey: "business", keys: "SECRET-LIST", hotkey: "ctrl" };
    const out = redactSecrets(msg) as Record<string, string>;
    expect(out.keyboard).toBe("cmd+k");
    expect(out.monkey).toBe("business");
    expect(out.hotkey).toBe("ctrl");
    // `keys` standing alone IS treated as a credential holder
    expect(out.keys).toContain("redacted");
  });

  it("survives cycles-adjacent depth and non-objects", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    let deep: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

import { redactSecretsInText } from "./redact.ts";
import { clip, describeResult, DETAIL_LIMIT } from "../shared/tool-activity.ts";

// Obviously-fake credential material, assembled from pieces so no
// token-shaped literal sits in the source (GitHub push protection rightly
// flags those) and so nobody reading the file mistakes it for a live key.
const FAKE = "RkFLRQ"; // base64 of "FAKE"
const FAKE_KEY_BODY = "FAKEFAKE".repeat(38); // 304 chars of nothing
const JWT_HEADER = "eyJhbGciOiJGQUtFIn0"; // base64url of {"alg":"FAKE"}
const JWT_PAYLOAD = `eyJwYXlsb2FkIjoi${FAKE.repeat(40)}`; // long enough to outlive the clip
const JWT_SIG = "RkFLRVNJRw"; // base64 of "FAKESIG"
const OPAQUE = `FAKE${"0123456789".repeat(30)}`; // a 304-char opaque value

// Content-shaped secrets: what a bot's own reply, a tool title, or a
// permission card can carry.  High precision on purpose — a false positive
// here rewrites real code in the transcript.
describe("redactSecretsInText", () => {
  it("masks known key prefixes wherever they appear", () => {
    // fixtures are assembled at runtime so no token-shaped literal sits in
    // the source — GitHub's push protection (rightly) flags those
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cases: Array<[string, RegExp]> = [
      [`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`, /sk-ant/],
      [`OpenAI: sk-proj-${alpha}ABCD`, /sk-proj/],
      [`gh token ${"gh" + "p_"}${alpha}`, /ghp_/],
      [`fine-grained ${"github_" + "pat_"}11ABCDEFG0${alpha}`, /github_pat_/],
      [`slack ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`, /xoxb-/],
      [`aws ${"AKIA" + "IOSFODNN7EXAMPLE"} and more`, /IOSFODNN7EXAMPLE/],
      [`google ${"AIza" + "SyA-"}${alpha.slice(0, 32)}`, /AIza/],
      [`npm ${"npm" + "_"}${alpha}`, /npm_[a-z]/],
      // xAI ships as a BotFleet engine, so a Grok key is a credential this
      // product hands its own users; Groq and Hugging Face ride along.
      [`XAI_API_KEY ${"xai" + "-"}${alpha}${alpha}`, /xai-[a-z]/],
      [`groq ${"gsk" + "_"}${alpha}${alpha.slice(0, 16)}`, /gsk_[a-z]/],
      [`hugging face ${"hf" + "_"}${alpha}`, /hf_[a-z]/],
    ];
    for (const [input, leak] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toMatch(leak);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("masks an xAI key pasted into a tool result, and says how long it was", () => {
    // The shape that reaches the canonical log: a bot pastes its own engine
    // key into a command it is asking permission to run.
    const key = `${"xai" + "-"}${"abcdefghijklmnopqrstuvwxyz0123456789".repeat(2)}`;
    const out = redactSecretsInText(`running: curl -H "x-api-key: ${key}" https://api.x.ai/v1/models`);
    expect(out).not.toContain(key);
    expect(out).toContain(`«redacted ${key.length} chars»`);
    // The command around it still reads, which is what a bug report is for.
    expect(out).toContain("https://api.x.ai/v1/models");
  });

  it("leaves a mask alone on a second pass over a masked engine key", () => {
    // Redaction runs twice by design; the second pass must report the
    // secret's length, not the marker's.
    const key = `${"xai" + "-"}${"abcdefghijklmnopqrstuvwxyz0123456789".repeat(2)}`;
    const once = redactSecretsInText(`key ${key}`);
    expect(redactSecretsInText(once)).toBe(once);
  });

  it("masks JWTs, PEM private key blocks, and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecretsInText(`here:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toMatch(/BEGIN OPENSSH PRIVATE KEY[\s\S]*«redacted \d+ chars»[\s\S]*END OPENSSH PRIVATE KEY/);
    expect(redactSecretsInText('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"')).toBe('curl -H "Authorization: Bearer «redacted 24 chars»"');
  });

  it("masks a truncated PEM private key block that lost its closing trailer", () => {
    const truncatedPem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0abcdefghijklm1234567890";
    const out = redactSecretsInText(`output: ${truncatedPem}`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA0abcdef");
    expect(out).toMatch(/BEGIN RSA PRIVATE KEY[\s\S]*«redacted \d+ chars»/);
  });

  // ── truncated shapes ────────────────────────────────────────────────
  // Redaction now runs before the transcript clip (see describeResult), but
  // a pre-clipped detail still reaches this function on paths we do not own,
  // and a secret cut in half has lost the closing marker the naive patterns
  // anchor on.  Each case below is the same secret put through `clip` at the
  // driver's own DETAIL_LIMIT, which is exactly how it used to get through.

  it("masks a JWT that lost its third segment to a clip", () => {
    // assembled from obviously-fake base64 so no token-shaped literal sits
    // in the source: "FAKE"/"FAKESIG" encoded, and an {"alg":"FAKE"} header
    const jwt = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIG}`;
    const raw = `POST /v1/thing failed, sent Authentication with ${jwt} and got 401`;
    expect(raw.length).toBeGreaterThan(DETAIL_LIMIT);

    const clipped = clip(raw, DETAIL_LIMIT);
    // the clip really did remove the signature — otherwise this proves nothing
    expect(clipped).not.toContain(JWT_SIG);
    expect(clipped).toContain(JWT_PAYLOAD.slice(0, 40));

    const out = redactSecretsInText(clipped);
    expect(out).not.toContain(JWT_PAYLOAD.slice(0, 40));
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("masks a JWT cut mid-payload with no third segment at all", () => {
    const cut = `${JWT_HEADER}.${JWT_PAYLOAD.slice(0, 60)}`;
    const out = redactSecretsInText(`bearer exchange failed for ${cut}`);
    expect(out).not.toContain(JWT_PAYLOAD.slice(0, 20));
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("still masks a complete three-segment JWT", () => {
    const jwt = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIG}`;
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
  });

  it("masks a quoted secret value whose closing quote was clipped away", () => {
    const raw = `curl failed: {"api_key":"${OPAQUE}","retry":false}`;
    expect(raw.length).toBeGreaterThan(DETAIL_LIMIT);

    const clipped = clip(raw, DETAIL_LIMIT);
    // the clip really did remove the closing quote KEY_VALUE needs via \3
    expect(clipped).not.toContain('","retry"');
    expect(clipped).toContain(OPAQUE.slice(0, 40));

    const out = redactSecretsInText(clipped);
    expect(out).not.toContain(OPAQUE.slice(0, 40));
    expect(out).toContain('"api_key":"«redacted');
  });

  it("masks an unterminated quoted value for every secret-shaped key it knows", () => {
    for (const key of ["api_key", "apiKey", "client_secret", "access_token", "password", "AUTHORIZATION"]) {
      const out = redactSecretsInText(`failed: {"${key}":"${OPAQUE.slice(0, 120)}`);
      expect(out, key).not.toContain(OPAQUE.slice(0, 20));
      expect(out, key).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("does not mask an unterminated value twice", () => {
    // the prefix pass gets there first; a second mask would report the
    // length of the marker instead of the length of the secret
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const out = redactSecretsInText(`{"api_key":"${key}`);
    expect(out).toBe(`{"api_key":"«redacted ${key.length} chars»`);
  });

  it("masks the whole value of an authorization header, whatever the scheme", () => {
    // `curl -v` prints these verbatim, and a scheme-prefixed credential has
    // a space in it, which is exactly what KEY_VALUE refuses to cross.  The
    // header name and the scheme survive; the credential does not.
    const HEADER = "Auth" + "orization";
    const value = `ZmFrZXVzZXI6${"FAKE".repeat(6)}`;
    const cases = [
      `> ${HEADER}: Basic ${value}`,
      `${HEADER}: Token ${value}`,
      `${HEADER.toLowerCase()}: bearer ${value}`,
      `{"${HEADER.toLowerCase()}": "Basic ${value}"}`,
      `Proxy-${HEADER}: Digest ${value}`,
      `${HEADER.toLowerCase()}=Token ${value}`,
      `${HEADER}: ${value}`, // no scheme at all
    ];
    for (const input of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toContain(value);
      expect(out, input).toMatch(/«redacted \d+ chars»/);
      // the shape a reader debugs with survives
      expect(out.toLowerCase(), input).toContain(HEADER.toLowerCase());
    }
  });

  it("masks a multi-part authorization header through its LAST part", () => {
    // A structured credential hides its secret at the END: SigV4 signs with
    // `…, Signature=<secret>` after two harmless parameters, and Digest
    // quotes each parameter separately.  Stopping at the first token would
    // mask the harmless half and ship the signature.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIGNATURE${"0123456789".repeat(2)}FAKE`;
    const sigv4 = `${HEADER}: AWS4-HMAC-SHA256 Credential=FAKEAKIA/20260909/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=${sig}`;
    const digest = `${HEADER}: Digest username="fakeuser", realm="test", nonce="FAKENONCE0123", response="${sig}"`;
    for (const input of [sigv4, digest]) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toContain(sig);
      expect(out, input).toMatch(/«redacted \d+ chars»/);
    }
    // the scheme survives, so the line still says what kind of credential
    // went out — that is the diagnostic the mask is meant to leave behind
    expect(redactSecretsInText(sigv4)).toContain("AWS4-HMAC-SHA256");
    expect(redactSecretsInText(digest)).toContain("Digest");
  });

  // ── where the value ENDS ────────────────────────────────────────────
  // Two shapes pull in opposite directions, which is why the value's end is
  // decided by CONTEXT rather than by scanning for pairs of quotes: a BARE
  // header line is ended by the line and so may cross a quoted parameter of
  // any length, while a QUOTE-INTRODUCED value is ended by its own closing
  // quote and must not cross one at all.

  it("masks an OAuth signature far longer than any cap, on a bare header line", () => {
    // `oauth_signature` is routinely a few hundred characters.  A cap on the
    // quoted part of the value ended the match at that parameter, and the
    // signature went on into the transcript and into Sentry in the clear.
    const HEADER = "Auth" + "orization";
    const sig = "FAKE".repeat(86); // 344 chars, well past any cap
    expect(sig.length).toBe(344);
    const oauth =
      `${HEADER}: OAuth oauth_consumer_key="FAKECONSUMER", oauth_nonce="FAKENONCE0123",` +
      ` oauth_signature="${sig}", oauth_signature_method="HMAC-SHA1", oauth_version="1.0"`;
    const out = redactSecretsInText(oauth);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    // the scheme survives, so the line still says what went out
    expect(out).toContain("OAuth «redacted");
    expect(out).toBe(redactSecretsInText(out));
  });

  it("ends a quote-introduced value at its closing quote, leaving the siblings", () => {
    // A one-line serialized object carries `status` and `message` AFTER the
    // header key.  The balanced-quote scan used to run past the end of the
    // value and eat them, so they were permanently missing from stored bot
    // text and from failure details.
    //
    // The spacing after the colon is part of the case, not decoration: the
    // bare pattern must not be able to give back the separator's trailing
    // whitespace and reclaim a value the quoted pattern already owns.
    const HEADER = "auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`; // 94 chars
    for (const q of ['"', "'"]) {
      for (const gap of ["", " ", "  "]) {
        const label = `${q}|${gap.length}`;
        const input = `{${q}${HEADER}${q}:${gap}${q}${SCHEME} ${token}${q},${q}status${q}:${q}ok${q},${q}message${q}:${q}sent${q}}`;
        const out = redactSecretsInText(input);
        expect(out, label).not.toContain(token);
        expect(out, label).toContain(`${SCHEME} «redacted ${token.length} chars»`);
        expect(out, label).toContain(`${q}status${q}:${q}ok${q}`);
        expect(out, label).toContain(`${q}message${q}:${q}sent${q}`);
        // the closing syntax survives too — a reclaim would have eaten it
        expect(out, label).toMatch(/}$/);
        expect(out, label).toBe(redactSecretsInText(out));
      }
    }
  });

  it("steps over a backslash-escaped quote inside a quote-introduced value", () => {
    // The escape is part of the value; the value ends at the first UNESCAPED
    // quote, not at the escaped one.
    const HEADER = "auth" + "orization";
    const token = `FAKE\\"${"0123456789".repeat(6)}`; // an escaped quote, then 60 chars
    const input = `{"${HEADER}":"Bearer ${token}","status":"ok"}`;
    const out = redactSecretsInText(input);
    expect(out).not.toContain("0123456789");
    expect(out).toContain(`Bearer «redacted ${token.length} chars»`);
    expect(out).toContain('"status":"ok"');
  });

  it("masks both header forms through describeResult's bounded window", () => {
    // describeResult is where redaction actually runs on provider output, and
    // it redacts a window and then clips to DETAIL_LIMIT.  Both shapes have to
    // survive that path, not just a direct call.
    const HEADER = "Auth" + "orization";
    const sig = "FAKE".repeat(86);
    const bare = `curl failed: ${HEADER}: OAuth oauth_token="FAKETOKEN01", oauth_signature="${sig}"`;
    expect(bare.length).toBeGreaterThan(DETAIL_LIMIT);
    const bareOut = describeResult(bare) ?? "";
    expect(bareOut).not.toContain(sig.slice(0, 40));
    expect(bareOut).toContain("«redacted");

    const token = `FAKE${"0123456789".repeat(30)}`; // 304 chars
    const json = `{"${HEADER.toLowerCase()}":"Bearer ${token}","status":"failed","message":"upstream said no"}`;
    expect(json.length).toBeGreaterThan(DETAIL_LIMIT);
    const jsonOut = describeResult(json) ?? "";
    expect(jsonOut).not.toContain(token.slice(0, 40));
    expect(jsonOut).toContain("«redacted");
    // the siblings are the reason the detail is worth reading at all
    expect(jsonOut).toContain('"status":"failed"');
    expect(jsonOut).toContain('"message":"upstream said no"');
  });

  it("masks a quote-introduced authorization value whose closing quote was clipped", () => {
    // A value cut before its own closing quote has no other end left, so the
    // quote-introduced pattern ends it at the end of the text.  This is the
    // shape the unterminated key=value fallback cannot reach: OAuth and
    // Digest write ESCAPED quotes inside the value, and that pattern's value
    // class stops at the first quote of any kind.
    const HEADER = "auth" + "orization";
    const sig = "FAKE".repeat(86);
    const raw = `{"${HEADER}":"OAuth oauth_signature=\\"${sig}\\", oauth_nonce=\\"FAKENONCE0123\\""}`;
    expect(raw.length).toBeGreaterThan(DETAIL_LIMIT);

    const clipped = clip(raw, DETAIL_LIMIT);
    // the clip really did remove the quote that closes the value
    expect(clipped).not.toContain('oauth_nonce');
    expect(clipped).toContain(sig.slice(0, 40));

    const out = redactSecretsInText(clipped);
    expect(out).not.toContain(sig.slice(0, 40));
    expect(out).toMatch(/«redacted \d+ chars»/);
    expect(out).toBe(redactSecretsInText(out));
    // and the reported length is the secret's, not a marker's
    expect(out).not.toMatch(/«redacted \d+ chars»[^«]*«redacted/);
  });

  it("masks a folded header whose credential sits on the continuation line", () => {
    // RFC 7230 obs-fold, and what a pretty-printer produces: the break falls
    // between the scheme and the credential.  "Runs to the end of the line"
    // has to mean the line the credential is on, or the bare pattern sees a
    // six-character `Digest`, declines it, and nothing else knows what the
    // continuation line is.
    const HEADER = "Auth" + "orization";
    const secret = `FAKESECRET${"0123456789".repeat(4)}`;
    // the fold can also fall right after the colon, before the scheme
    const afterColon = `${HEADER}:\n  Basic ${secret}`;
    expect(redactSecretsInText(afterColon)).not.toContain(secret);
    expect(redactSecretsInText(afterColon)).toContain("Basic");
    for (const fold of ["\n ", "\n\t", "\n  "]) {
      const label = JSON.stringify(fold);
      const input = `${HEADER}: Digest${fold}username="fakeuser", response="${secret}"`;
      const out = redactSecretsInText(input);
      expect(out, label).not.toContain(secret);
      // the scheme still survives, on the line the reader is looking at
      expect(out, label).toContain("Digest");
      expect(out, label).toMatch(/«redacted \d+ chars»/);
      expect(out, label).toBe(redactSecretsInText(out));
    }
  });

  it("masks a bare header that was clipped inside a quoted parameter", () => {
    // The parameter's own closing quote went with the clip, so a pattern that
    // only knows BALANCED parameters stops at the opening quote and masks
    // `oauth_signature=` while the signature itself walks out behind it.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    for (const input of [
      `${HEADER}: OAuth oauth_signature="${sig}`,
      `curl -H "${HEADER}: OAuth oauth_signature=\\"${sig}`,
    ]) {
      const out = redactSecretsInText(input);
      expect(out, input.slice(0, 24)).not.toContain(sig);
      expect(out, input.slice(0, 24)).toMatch(/«redacted \d+ chars»/);
      expect(out, input.slice(0, 24)).toBe(redactSecretsInText(out));
    }
  });

  it("stops a bare header at its shell wrapper, keeping the rest of the command", () => {
    // A quote only opens a parameter when an `=` introduces it (RFC 7235
    // auth-param).  Pairing quotes off instead makes the value swallow
    // everything between the wrapper's closing quote and the next quoted
    // argument — with no length cap, the whole command tail, which the reader
    // needs and which is not a credential.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const tail = ' https://api.example.com/v1/a/very/long/path?with=query&and=more -d "{ok:1}"';

    const plain = `curl -H "${HEADER}: ${SCHEME} ${token}"${tail}`;
    const plainOut = redactSecretsInText(plain);
    expect(plainOut).not.toContain(token);
    expect(plainOut).toContain(tail);

    // and the same with real quoted parameters inside the wrapper
    const withParams = `curl -H "${HEADER}: OAuth a=\\"1\\", oauth_signature=\\"${sig}\\""${tail}`;
    const paramsOut = redactSecretsInText(withParams);
    expect(paramsOut).not.toContain(sig);
    expect(paramsOut).toContain(tail);

    // Basic is the sharp one: base64 padding ends the credential in `=`, so
    // the wrapper quote sits directly behind an `=` and looks exactly like a
    // parameter opening.  A parameter has to CLOSE like one too — its closing
    // quote is followed by a delimiter, not by more argument text.
    for (const b64 of ["ZmFrZXVzZXI6ZmFrZXBhc3N3b3JkMTIzNDU2Nzg=", "ZmFrZXVzZXI6ZmFrZXBhc3N3b3JkMTIzNDU2NzQ9PQ=="]) {
      const basic = `curl -H "${HEADER}: Basic ${b64}"${tail}`;
      const basicOut = redactSecretsInText(basic);
      expect(basicOut, b64.slice(-4)).not.toContain(b64);
      expect(basicOut, b64.slice(-4)).toContain(tail);
      expect(basicOut, b64.slice(-4)).toContain(`Basic «redacted ${b64.length} chars»`);

      // and when that wrapper is the LAST quote on the line there is no
      // partner ahead of it either, so only a credential-shaped character
      // behind the quote tells a cut parameter from a terminal wrapper
      const url = " https://api.example.com/v1/long/path";
      const terminal = `curl -H "${HEADER}: Basic ${b64}"${url}`;
      const terminalOut = redactSecretsInText(terminal);
      expect(terminalOut, b64.slice(-4)).not.toContain(b64);
      expect(terminalOut, b64.slice(-4)).toContain(url);

      // and when the NEXT argument opens with a delimiter of its own
      const delimLed = `curl -H "${HEADER}: Basic ${b64}" https://x -d ",foo"`;
      const delimLedOut = redactSecretsInText(delimLed);
      expect(delimLedOut, b64.slice(-4)).not.toContain(b64);
      expect(delimLedOut, b64.slice(-4)).toContain(' https://x -d ",foo"');
    }
  });

  it("treats every quote in a bare value as content, wrapper excepted", () => {
    // Nothing on the header line tells a parameter's quote from a wrapper's,
    // which is why reading the value's own quotes to find its end kept
    // getting one shape or another wrong: `\"` is the parameter's delimiter
    // inside a shell argument and an escape inside it on a raw line, and a
    // delimiter behind an escaped quote makes the wrong reading look right.
    // The wrapper is the only quote that has to survive, and it announced
    // itself before the header name.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://api.example.com/v1/long/path";
    const cases: Array<[string, string]> = [
      [`${HEADER}: OAuth realm="a\\"b", oauth_signature="${sig}"`, ""],
      [`${HEADER}: OAuth realm="a\\",b", oauth_signature="${sig}"`, ""],
      [`${HEADER}: OAuth oauth_signature = "${sig}"`, ""],
      // clipped mid-parameter, with an escaped quote already inside it
      [`${HEADER}: OAuth oauth_signature="prefix\\"${sig}`, ""],
      // and the same shapes wrapped in a shell argument, tail intact
      [`curl -H "${HEADER}: OAuth a=\\"1\\", oauth_signature=\\"${sig}\\""${url}`, url],
      [`curl -H "${HEADER}: OAuth oauth_signature = \\"${sig}\\""${url}`, url],
      [`curl -H '${HEADER}: OAuth oauth_signature=${sig}'${url}`, url],
      // a balanced quoted run before the header leaves no wrapper open
      [`echo "hi" && curl -H "${HEADER}: OAuth oauth_signature=\\"${sig}\\""${url}`, url],
    ];
    for (const [input, keep] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input.slice(0, 46)).not.toContain(sig);
      expect(out, input.slice(0, 46)).toMatch(/«redacted \d+ chars»/);
      if (keep) expect(out, input.slice(0, 46)).toContain(keep);
      expect(out, input.slice(0, 46)).toBe(redactSecretsInText(out));
    }
  });

  it("masks a short credential when a scheme has already anchored the match", () => {
    // The eight-character floor is there to keep prose after a colon out of
    // the mask, and a recognised scheme retires that worry: `Basic` standing
    // behind the header name cannot be prose, so what follows it is a
    // credential however short.  `dTpw` is base64 for `u:p`.
    const HEADER = "Auth" + "orization";
    for (const input of [`${HEADER.toLowerCase()}="Basic dTpw"`, `${HEADER}: Basic dTpw`, `${HEADER}: Basic dTpw\n`]) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toContain("dTpw");
      expect(out, input).toContain("Basic «redacted 4 chars»");
    }
    // without a scheme the floor still stands, so prose after a colon is safe
    expect(redactSecretsInText("password: (leave blank to keep the current one)")).toBe(
      "password: (leave blank to keep the current one)",
    );
    // and the scheme group matches any short alphabetic token, so the floor
    // only drops for a word that really does carry short credentials — this
    // function reads bot text and permission-card copy too
    // (a value of eight characters or more is masked with or without a scheme,
    // which is the floor doing its job and is how this behaved before)
    for (const status of [
      `${HEADER}: not set`,
      `${HEADER}: was empty`,
      `${HEADER}: nil yet`,
      `${HEADER}: no value`,
      `${HEADER}: not provided`,
      `${HEADER}: was not set`,
      `${HEADER}: header missing`,
    ]) {
      expect(redactSecretsInText(status), status).toBe(status);
    }
    // documentation placeholders are not credentials at any length, and this
    // text is persisted guidance a reader is meant to follow
    const SCHEME_WORD = "Bearer";
    for (const doc of [
      `Set ${HEADER}: ${SCHEME_WORD} <token>`,
      `Use ${HEADER}: Basic {api-key}`,
      `Send ${HEADER}: ${SCHEME_WORD} [YOUR_TOKEN]`,
      `${HEADER}: ${SCHEME_WORD} <your-api-token-here>`,
      // the bare noun a sentence uses when it means "put yours here"
      `Use ${HEADER}: ${SCHEME_WORD} token`,
      `Set ${HEADER}: ${SCHEME_WORD} secret`,
      `${HEADER}: ${SCHEME_WORD} your-api-key`,
      // a filler run (xxxx, ****, …) is documentation only behind a
      // recognised lead-in verb too — see the round-4 finding below
      `Use ${HEADER}: ${SCHEME_WORD} xxxxxxxx`,
      `send ${SCHEME_WORD} your_token in the header`,
      // trailing sentence punctuation belongs to the prose
      `Use ${HEADER}: ${SCHEME_WORD} token.`,
      `Set ${HEADER}: ${SCHEME_WORD} <token>.`,
    ]) {
      expect(redactSecretsInText(doc), doc).toBe(doc);
    }
    // and a real credential is still masked, including one that reads like a
    // placeholder: a `your`/`my` prefix only counts with a separator after
    // it, so `your-api-key` is documentation and `yourtoken` is a credential
    expect(redactSecretsInText(`${HEADER}: Basic dTpw`)).toContain("«redacted 4 chars»");
    for (const real of [`${HEADER}: ${SCHEME_WORD} yourtoken`, `${HEADER}: ${SCHEME_WORD} mysecret`]) {
      expect(redactSecretsInText(real), real).toMatch(/«redacted \d+ chars»/);
    }
    // an EXACT placeholder word is only documentation behind a recognised
    // lead-in verb ("Use", "Set", …) — the same word with nothing marking it
    // that way is a real, if bad, credential and must still be masked, the
    // same as before the placeholder exemption existed (round-2 finding: a
    // blanket exemption for exact placeholder words let `Bearer password`
    // through unmasked)
    for (const real of [`${HEADER}: Basic password`, `${HEADER}: ${SCHEME_WORD} secret,`]) {
      expect(redactSecretsInText(real), real).toMatch(/«redacted \d+ chars»/);
    }
  });

  it("only treats a quote ADJACENT to the header as its wrapper", () => {
    // An argument that wraps a header opens immediately in front of it.  A
    // quote with text between it and the header name wraps something else,
    // or nothing — and an unbalanced one in log text delimits nothing at all.
    // Cutting the value there left a stub and handed the credential back.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const strays: Array<[string, string]> = [
      ['size=2"; ', "size=2"],
      ["it's odd; ", "it's odd"],
      // one that opens the way a shell argument opens is still not adjacent
      ['he said "wat; ', "he said"],
      ["foo \"bar' ", "foo"],
    ];
    // and an adjacent quote that CLOSES rather than opens does the same
    // damage — a shell word can concatenate a quoted prefix onto the header
    for (const line of [
      `curl "prefix"${HEADER}: OAuth realm="public", oauth_signature="${sig}"`,
      // and a same-type literal inside opposite quotes must not poison the
      // count that decides opening from closing
      `echo '"' && curl "prefix"${HEADER}: OAuth realm="public", oauth_signature="${sig}"`,
    ]) {
      const closing = redactSecretsInText(line);
      expect(closing, line.slice(0, 20)).not.toContain(sig);
      expect(closing, line.slice(0, 20)).toContain("curl");
    }

    for (const [prefix, keep] of strays) {
      const out = redactSecretsInText(`${prefix}${HEADER}: OAuth realm="public", oauth_signature="${sig}"`);
      expect(out, prefix).not.toContain(sig);
      if (keep) expect(out, prefix).toContain(keep);
      expect(out, prefix).toBe(redactSecretsInText(out));
    }

    // adjacency does not mean the header must be a `-H` argument: a log line
    // that quoted the header is wrapped by that quote just the same
    const logged = redactSecretsInText(`sent header "${HEADER}: OAuth oauth_signature=\\"${sig}\\"" to upstream`);
    expect(logged).not.toContain(sig);
    expect(logged).toContain("to upstream");

    // and it is what lets this not parse shell quoting, which cannot be got
    // right from one line: whether the `'` in `echo "it's ready"` is a nested
    // opener or a literal has no answer that also works for `bash -c '… "…"'`
    const url = " https://api.example.com/v1/long/path";
    const token = `FAKE${"0123456789".repeat(9)}`;
    for (const before of ['echo "it\'s ready" && ', 'echo "say \\"hi\\"" && ', 'echo "hi" && ']) {
      const out = redactSecretsInText(`${before}curl -H "${HEADER}: Digest ${token}"${url}`);
      expect(out, before).not.toContain(token);
      expect(out, before).toContain(url);
    }
  });

  it("recognises a wrapper that starts mid-word, and a short credential inside one", () => {
    // Shell quoting may begin in the middle of a word — `-H"…"` is one
    // argument to bash — so a wrapper is not always preceded by whitespace.
    // And once a scheme has anchored the match the credential may be short,
    // so a length test cannot stand in for wrapper detection either: both
    // used to run to the end of the line and take the URL with them.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const url = " https://api.example.com/v1/long/path";
    for (const input of [
      `curl -H"${HEADER}: ${SCHEME} ${token}"${url}`,
      `curl -H'${HEADER}: ${SCHEME} ${token}'${url}`,
    ]) {
      const out = redactSecretsInText(input);
      expect(out, input.slice(0, 24)).not.toContain(token);
      expect(out, input.slice(0, 24)).toContain(url);
    }
    // a redirection closes the argument too — bash reads `>` as an operator
    // bash glues an adjacent quoted and unquoted run into one word, so a `$`
    // expansion or another quote closes the argument just as a space does
    for (const redirect of [">trace.log", "<in.txt", "&& echo done", "$SUFFIX", "'more'", '"more"']) {
      const out = redactSecretsInText(`curl -H "${HEADER}: ${SCHEME} ${token}"${redirect}`);
      expect(out, redirect).not.toContain(token);
      expect(out, redirect).toContain(redirect);
    }

    const short = redactSecretsInText(`curl -H "${HEADER}: Basic dTpw"${url}`);
    expect(short).not.toContain("dTpw");
    expect(short).toContain("Basic «redacted 4 chars»");
    expect(short).toContain(url);

    // A command serialized one level up wraps with `\\"` and writes its own
    // quoted parameters `\\\\\\"` — three backslashes, the next level in.  The
    // closing quote is the one at the WRAPPER's level, so the backslash run
    // has to match exactly; stopping at an inner one masks through
    // `oauth_signature=\\\\` and leaves the signature standing.
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const nested = `curl -H \\"${HEADER}: OAuth oauth_signature=\\\\\\"${sig}\\\\\\"\\"${url}`;
    const nestedOut = redactSecretsInText(nested);
    expect(nestedOut).not.toContain(sig);
    expect(nestedOut).toContain(url);
    expect(nestedOut).toBe(redactSecretsInText(nestedOut));
  });

  it("finds the wrapper through escaping and nesting", () => {
    // A driver often hands us the command already inside a string, so the
    // wrapper arrives spelled `\"` and closes the same way; and quotes nest,
    // so the header's own argument ends at the INNERMOST open quote, not the
    // outermost.  Getting either wrong puts the rest of the command line in
    // the mask instead of the credential alone.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const url = " https://api.example.com/v1/long/path";
    for (const input of [
      `curl -H \\"${HEADER}: ${SCHEME} ${token}\\"${url}`,
      `bash -c 'curl -H "${HEADER}: ${SCHEME} ${token}"${url}'`,
      `bash -c "curl -H '${HEADER}: ${SCHEME} ${token}'${url}"`,
    ]) {
      const out = redactSecretsInText(input);
      expect(out, input.slice(0, 24)).not.toContain(token);
      expect(out, input.slice(0, 24)).toContain(`${SCHEME} «redacted ${token.length} chars»`);
      expect(out, input.slice(0, 24)).toContain(url);
      expect(out, input.slice(0, 24)).toBe(redactSecretsInText(out));
    }
  });

  it("keeps scanning past a shell requote for a later field in the same header value", () => {
    // Bash glues a quoted segment, an unquoted `$` expansion, and another
    // quoted segment into ONE shell word (confirmed against bash 5.2.21):
    // `-H "Authorization: OAuth realm="$REALM", oauth_signature="…""` is a
    // single -H argument whose quoting merely toggles off and back on before
    // the wrapper itself actually closes.  The quote right before `$REALM`
    // looks exactly like the wrapper's close in isolation — that is what the
    // `$SUFFIX`-after-the-wrapper case needed to treat as a close — and
    // treating it as one here used to stop the mask at `realm=` and hand
    // `oauth_signature`, the real secret, back in the clear.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://api.example.com/v1/long/path";
    const withRealm = `curl -H "${HEADER}: OAuth realm="$REALM", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(withRealm);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // and the `$SUFFIX`-after-the-wrapper case this shares its mechanism
    // with still keeps its tail, because the glued run there never runs
    // into a further quote of the wrapper's kind
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const suffixed = redactSecretsInText(`curl -H "${HEADER}: ${SCHEME} ${token}"$SUFFIX${url}`);
    expect(suffixed).not.toContain(token);
    expect(suffixed).toContain("$SUFFIX");
    expect(suffixed).toContain(url);
  });

  it("masks an authorization value that another pass had already half-masked", () => {
    // SigV4 carries an access-key id BEFORE the signature, so the prefix
    // pass has a shot at part of the value first.  A "does it contain a
    // mask" short-circuit would call that value done and ship the signature;
    // only a WHOLLY masked value may be skipped.
    const HEADER = "Auth" + "orization";
    const akia = `AKIA${"FAKEFAKEFAKEFAKE"}`;
    const sig = `FAKESIGNATURE${"0123456789".repeat(2)}FAKE`;
    const input = `${HEADER}: AWS4-HMAC-SHA256 Credential=${akia}/20260909/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=${sig}`;
    const out = redactSecretsInText(input);
    expect(out).not.toContain(sig);
    expect(out).not.toContain(akia);
    expect(out).toContain("AWS4-HMAC-SHA256");
  });

  it("is idempotent — a second pass keeps the first pass's reported length", () => {
    // Redaction runs twice by design now: `describeResult()` before the clip
    // and the Sentry observer after.  If the second pass masked the marker,
    // Sentry would record the marker's length instead of the secret's, and
    // the length is the whole diagnostic value of keeping the shape.
    const HEADER = "Auth" + "orization";
    const inputs = [
      `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`,
      `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}`,
      `${HEADER}: Basic ${OPAQUE.slice(0, 60)}`,
      `{"api_key":"${OPAQUE.slice(0, 60)}"}`,
      `{"api_key":"${OPAQUE.slice(0, 60)}`,
      `token ${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIG} ok`,
    ];
    for (const input of inputs) {
      const once = redactSecretsInText(input);
      expect(redactSecretsInText(once), input.slice(0, 40)).toBe(once);
    }
    // and the length reported really is the secret's, not the marker's
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;
    expect(redactSecretsInText(redactSecretsInText(pem))).toContain(`«redacted ${FAKE_KEY_BODY.length} chars»`);
  });

  it("does not treat a scheme word in prose as a credential", () => {
    // the header NAME is what makes the space in a scheme-prefixed value
    // safe to cross — a bare scheme word would be a false-positive machine
    for (const s of [
      "Basic authentication requires a username and a password",
      "Token expired yesterday afternoon",
      "The Authorization header must be present on every request",
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("leaves a PEM footer intact when nothing was clipped", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${FAKE_KEY_BODY}\n-----END RSA PRIVATE KEY-----`;
    const out = redactSecretsInText(pem);
    expect(out).not.toContain("FAKEFAKE");
    expect(out).toContain("-----END RSA PRIVATE KEY-----");
  });

  it("masks the value of a secret-shaped key=value or key: value, keeping the key", () => {
    expect(redactSecretsInText("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=«redacted 14 chars»");
    expect(redactSecretsInText('{"api_key": "abcd1234efgh5678"}')).toBe('{"api_key": "«redacted 16 chars»"}');
    expect(redactSecretsInText("client_secret: 'zzzz-yyyy-xxxx-1'")).toBe("client_secret: '«redacted 16 chars»'");
    expect(redactSecretsInText("--token=abc123def456")).toBe("--token=«redacted 12 chars»");
  });

  it("leaves ordinary text, code, hashes and URLs alone", () => {
    for (const s of [
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "password: (leave blank to keep the current one)",
      "Bearer tokens are sent in the Authorization header",
      "sk-8", // too short to be a key
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("is applied to string values inside redactSecrets too", () => {
    const out = redactSecrets({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", note: "fine" }) as Record<string, string>;
    expect(out.command).toContain("«redacted");
    expect(out.note).toBe("fine");
  });

  // ── round-2 findings (fresh Codex re-review of 993a58e) ──────────────

  it("does not let an empty quoted parameter re-open the opener count for a poisoned line", () => {
    // Same class as the resolved opposite-quoted-literal thread, but the
    // credential's FIRST field is an EMPTY quoted parameter: `realm=""`.
    // Its opening quote is immediately followed by its own closing quote,
    // which satisfies the "next char is a quote" closer signal that exists
    // for a DIFFERENT reason (a wrapper's true close glued to a new quoted
    // shell word) — and that false match used to stop the mask right after
    // `realm=` and hand `oauth_signature` back in the clear.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const line = `echo '"' && curl "prefix"${HEADER}: OAuth realm="", oauth_signature=${sig}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).toContain("curl");
    expect(out).toBe(redactSecretsInText(out));
  });

  it("does not exempt a real Bearer credential that happens to spell an unmarked placeholder word", () => {
    // The placeholder exemption is for DOCUMENTATION — `Use Authorization:
    // Bearer token.` — which reads as a placeholder only because a leading
    // instruction verb marks it as guidance.  The exact same word with
    // nothing marking it that way is a real, if bad, credential and the
    // prior eight-character-floor behavior masked it; the placeholder
    // exemption must not blanket-exempt every occurrence of the word.
    const HEADER = "Auth" + "orization";
    for (const word of ["password", "secret", "token"]) {
      const real = `${HEADER}: Bearer ${word}`;
      const out = redactSecretsInText(real);
      expect(out, real).toMatch(/«redacted \d+ chars»/);
      expect(out, real).not.toMatch(new RegExp(`${word}$`));
    }
    // documentation with a recognised lead-in verb still survives
    for (const doc of [`Use ${HEADER}: Bearer token`, `Set ${HEADER}: Bearer secret`, `Use ${HEADER}: Bearer password`]) {
      expect(redactSecretsInText(doc), doc).toBe(doc);
    }
  });

  it("stops the $SUFFIX continuation lookahead at a shell-word boundary", () => {
    // A later, unrelated quoted command (`&& echo "done"`) must not be
    // mistaken for this credential's own glued continuation — the lookahead
    // has to stop at the first real shell-word boundary, not scan arbitrarily
    // far ahead for any same-type quote.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const line = `curl -H "${HEADER}: ${SCHEME} ${token}"$SUFFIX https://example.com && echo "done"`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(token);
    expect(out).toContain("$SUFFIX");
    expect(out).toContain("https://example.com");
    expect(out).toContain('&& echo "done"');
  });

  // ── round-3 findings (fresh Codex re-review of e2a9b98) ───────────────

  it("masks a Bearer credential that happens to equal a single status word", () => {
    // `configured`, `provided`, and `available` are syntactically ordinary
    // Bearer tokens — long enough, no illegal characters — and nothing marks
    // a LONE status word as prose the way a second word does ("was
    // configured", "not provided").  The `every`-based status check used to
    // exempt each of them outright because a single word trivially satisfies
    // "every word is a status word"; only an unmistakable MULTIWORD status
    // phrase may bypass masking.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    for (const word of ["configured", "provided", "available"]) {
      const real = `${HEADER}: ${SCHEME} ${word}`;
      const out = redactSecretsInText(real);
      expect(out, real).toMatch(/«redacted \d+ chars»/);
      expect(out, real).not.toMatch(new RegExp(`${word}$`));
    }
    // a genuine multiword status sentence still reads as prose, not a
    // credential, and must stay untouched
    for (const status of [`${HEADER}: not configured`, `${HEADER}: was provided`, `${HEADER}: not available`]) {
      expect(redactSecretsInText(status), status).toBe(status);
    }
  });

  it("keeps scanning through a nested command substitution's whitespace", () => {
    // Command substitution replaces the whole `$(…)` with its output before
    // the shell word is assembled (confirmed against bash 5.2.21), so the
    // space inside `$(printf zone)` is never an outer shell-word boundary —
    // this is one continuous `-H` argument.  Stopping at that inner space
    // used to end the glued-run lookahead early and leave `oauth_signature`,
    // the real secret, standing past the cut — same failure mode as the
    // resolved `$REALM` case, and the same fix: the whole value from `realm=`
    // onward is masked as one blob, so nothing between it and the secret is
    // left standing either.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const withSubst = `curl -H "${HEADER}: OAuth realm="$(printf zone)", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(withSubst);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).not.toContain("printf zone");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // and the `$SUFFIX`-after-the-wrapper case this shares its mechanism
    // with still keeps its tail — a `$(…)` immediately after the wrapper's
    // own close must not be swallowed as if it were part of the value
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const suffixed = redactSecretsInText(`curl -H "${HEADER}: ${SCHEME} ${token}"$(hostname)${url}`);
    expect(suffixed).not.toContain(token);
    expect(suffixed).toContain("$(hostname)");
    expect(suffixed).toContain(url);
  });

  it("does not let a quote literal-protected by the opposite quote type hide the real wrapper opener", () => {
    // A single-quoted argument earlier on the line can contain a literal
    // double quote — `echo '"' …` — and bash never reads a character inside
    // single quotes as a delimiter.  Counting that literal as a real
    // double-quote toggle threw off the parity check and made the genuine
    // `-H "` opener that follows look like a CLOSER instead, losing the
    // wrapper entirely and letting redaction consume the closing quote, the
    // URL, and the rest of the command line.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const line = `echo '"' && curl -H "${HEADER}: ${SCHEME} ${token}" https://example.com`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(token);
    expect(out).toContain(`${SCHEME} «redacted ${token.length} chars»`);
    expect(out).toContain("https://example.com");
    expect(out).toBe(redactSecretsInText(out));
  });

  // ── round-4 finding (fresh Codex re-review of 47ceda1) ────────────────

  it("does not let a quoted paren inside $(...) close the substitution early", () => {
    // Bash parses a quoted or escaped `)` as part of the substituted
    // command, not as the substitution's own close — `$(printf ') value')`
    // is ONE substitution whose argument happens to contain a literal `)`.
    // The naive depth counter treated every `)` as structural regardless of
    // quoting, so it closed the span at the literal one and read the space
    // right after it as a real shell-word boundary — the exact failure the
    // depth tracking exists to prevent, one quoting level deeper.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="$(printf ') value')", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).not.toContain("printf");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // an escaped paren inside the substitution, outside any quote, gets the
    // same protection — bash still reads it as part of the command
    const escaped = redactSecretsInText(`curl -H "${HEADER}: OAuth realm="$(printf zone\\) done)", oauth_signature=${sig}"${url}`);
    expect(escaped).not.toContain(sig);
    expect(escaped).not.toContain("oauth_signature");
    expect(escaped).toContain(url);
  });

  // ── round-5 findings (fresh Codex re-review of cc001b3) ───────────────

  it("does not let an escaped space in a glued shell run look like a boundary", () => {
    // A backslash preserves the character after it literally (confirmed
    // against bash 5.2.21), so `$REALM\ value` glued onto the header value
    // is one continuous shell word even though it contains a space — the
    // escaped space is not where the outer boundary test should stop.  This
    // is the same failure mode as the resolved nested-`$(...)` case, one
    // escaping mechanism over: raw whitespace scanning cannot tell a real
    // boundary from a protected one.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="$REALM\\ value", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));
  });

  it("masks an unmarked filler-shaped Bearer token instead of treating it as a placeholder", () => {
    // A run of nothing but `x` (or `*`, `.`, `…`) LOOKS like a placeholder,
    // but it is also a perfectly syntactically valid Bearer token — nothing
    // in `Authorization: Bearer xxxxxxxxxxxx` on its own says which one it
    // is.  The filler check used to exempt it unconditionally; it now needs
    // the same recognised lead-in verb the bare-noun placeholder branch
    // already requires (round-2 finding, same reasoning: an exemption with
    // no marker in the text lets a real credential through).
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    for (const filler of ["xxxxxxxxxxxx", "************", "...................."]) {
      const withHeader = `${HEADER}: ${SCHEME} ${filler}`;
      expect(redactSecretsInText(withHeader), withHeader).toMatch(/«redacted \d+ chars»/);
    }
    // and standalone, outside any header — the same BEARER pattern reaches
    // persisted bot text directly.  Its token charset is narrower (no `*`),
    // so only the shapes it actually matches are exercised here.
    for (const filler of ["xxxxxxxxxxxx", "...................."]) {
      const standalone = `sent ${SCHEME} ${filler} to the proxy`;
      expect(redactSecretsInText(standalone), standalone).toMatch(/«redacted \d+ chars»/);
    }
    // documentation with a recognised lead-in verb still survives
    for (const doc of [`Use ${HEADER}: ${SCHEME} xxxxxxxxxxxx`, `Set ${HEADER}: ${SCHEME} ****************`]) {
      expect(redactSecretsInText(doc), doc).toBe(doc);
    }
  });

  // ── round-6 findings (fresh Codex re-review of f31f786) ───────────────

  it("keeps scanning through an ANSI-C quoted $'...' glued to the wrapper", () => {
    // `$'foo bar'` is bash's ANSI-C quoting — a QUOTED shell word, not a
    // balanced-paren expansion — so the space inside it is never an outer
    // boundary either (confirmed against bash 5.2.21: this is one complete
    // `-H` argument).  Its own backslash escapes are honored while walking
    // to the matching quote, so an escaped `\'` inside it does not end the
    // span early the way an unescaped one would.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="$'foo bar'", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // an escaped quote inside the ANSI-C string does not end it early
    const withEscape = redactSecretsInText(
      `curl -H "${HEADER}: OAuth realm="$'foo\\'bar'", oauth_signature=${sig}"${url}`,
    );
    expect(withEscape).not.toContain(sig);
    expect(withEscape).not.toContain("oauth_signature");
    expect(withEscape).toContain(url);
  });

  it("treats <(...) and >(...) process substitution as a glued expansion, not a redirection", () => {
    // `<(list)`/`>(list)` is replaced by a filename before the shell word is
    // assembled — the same "glues onto the surrounding word" story as
    // `$(…)` (confirmed against bash 5.2.21: this is one complete `-H`
    // argument), so it must NOT be read as the `<`/`>` redirection that
    // would otherwise end the argument right there.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="<(printf foo)", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // the output-side form, `>(...)`, gets the same treatment
    const outSide = redactSecretsInText(`curl -H "${HEADER}: OAuth realm=">(cat)", oauth_signature=${sig}"${url}`);
    expect(outSide).not.toContain(sig);
    expect(outSide).not.toContain("oauth_signature");

    // a BARE `<`/`>` (no paren) is still a real redirection and keeps
    // closing the argument the way it always has
    const SCHEME = "Bea" + "rer";
    const token = `FAKE${"0123456789".repeat(9)}`;
    const redirected = redactSecretsInText(`curl -H "${HEADER}: ${SCHEME} ${token}"<in.txt${url}`);
    expect(redirected).not.toContain(token);
    expect(redirected).toContain("<in.txt");
    expect(redirected).toContain(url);
  });

  // ── round-7 finding (fresh Codex re-review of 410a5dd) ────────────────

  it("keeps scanning through a ${...} parameter expansion glued to the wrapper", () => {
    // `${REALM:-'foo bar'}` (parameter expansion) is replaced before the
    // shell word is assembled, same as `$(...)` (confirmed against bash
    // 5.2.21: this is one complete `-H` argument) — and its fallback can
    // carry quoted whitespace of its own, so the space inside the braces is
    // never an outer boundary either.  Shares the same quote-aware balanced
    // walk as `$(...)`, just brace- instead of paren-delimited.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="\${REALM:-'foo bar'}", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // a nested ${...} (a braced fallback referencing another parameter)
    // still balances correctly
    const nested = redactSecretsInText(
      `curl -H "${HEADER}: OAuth realm="\${REALM:-\${OTHER:-'foo bar'}}", oauth_signature=${sig}"${url}`,
    );
    expect(nested).not.toContain(sig);
    expect(nested).not.toContain("oauth_signature");
    expect(nested).toContain(url);
  });

  // ── round-8 finding (fresh Codex re-review of 572fda1) ────────────────

  it("does not let an earlier shell command's first word act as this sentence's lead-in", () => {
    // `set` is both a placeholder lead-in verb AND a bash builtin.  A
    // recorded command line can run one before the command that actually
    // carries the header — `set -x; curl -H "Authorization: Bearer
    // password"` — and the lead-in check used to read the LINE's first
    // word, so `set` (shell setup, unrelated to the header) exempted a
    // real credential that happened to spell an unmarked placeholder word.
    // The check now looks only as far back as the nearest shell separator.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    for (const sep of [";", "&&", "|", "&"]) {
      const line = `set -x ${sep} curl -H "${HEADER}: ${SCHEME} password"`;
      const out = redactSecretsInText(line);
      expect(out, line).toMatch(/«redacted \d+ chars»/);
      expect(out, line).not.toMatch(/password"$/);
    }
    // a lead-in verb that genuinely introduces THIS clause still exempts —
    // separator-adjacent, not just line-initial
    const doc = `set -x; use ${HEADER}: ${SCHEME} password`;
    expect(redactSecretsInText(doc), doc).toBe(doc);
    // and the plain line-initial case (no earlier clause at all) is
    // unaffected
    const stillDoc = `Use ${HEADER}: ${SCHEME} password`;
    expect(redactSecretsInText(stillDoc), stillDoc).toBe(stillDoc);
  });

  // ── round-9 finding (fresh Codex re-review of f3f6957) ────────────────

  it("does not let a nested expansion's own close paren end the outer $(...) early", () => {
    // `$(printf %s ${X:-)x} tail)` is ONE command substitution (confirmed
    // against bash 5.2.21) — bash reads between MATCHING parens, and the
    // `)` inside the nested `${X:-)x}`'s fallback belongs to that nested
    // expansion, not to the outer $(...)'s own close.  A flat depth count
    // that does not recurse into the nested expansion mistakes it for the
    // outer close and reads the following space as a real boundary.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="$(printf %s \${X:-)x} tail)", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // and the nested expansion may itself be a command substitution with a
    // stray paren of its own, two levels of "own close, not the outer's"
    const doublyNested = redactSecretsInText(
      `curl -H "${HEADER}: OAuth realm="$(printf %s $(echo ')x'))", oauth_signature=${sig}"${url}`,
    );
    expect(doublyNested).not.toContain(sig);
    expect(doublyNested).not.toContain("oauth_signature");
    expect(doublyNested).toContain(url);
  });

  // ── round-10 findings (fresh Codex re-review of 117f50f, from a page of
  // results the prior rounds' 30-item default page size had been silently
  // cutting off — rounds 8 and 9 each actually carried two findings) ────

  it("does not let an escaped backtick end a legacy command substitution early", () => {
    // The first backquote NOT preceded by a backslash terminates a backtick
    // command substitution (Bash manual, Command Substitution) — so
    // `` `printf '\`value'` `` is one substitution whose argument happens
    // to contain a literal, escaped backtick, confirmed against bash
    // 5.2.21.  A scan that stops at the first backtick REGARDLESS of
    // escaping reads the escaped one as the close and the quote before the
    // substitution as the wrapper's own close instead.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="\`printf '\\\`value'\`", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));
  });

  it("does not read a direct `set` builtin invocation as a placeholder lead-in", () => {
    // `set -- Authorization: Bearer password` genuinely begins its own
    // clause with `set` (Bash assigns the rest to positional parameters,
    // `help set`) — restricting the lead-in check to the current clause
    // (the earlier round's fix) does not by itself tell that apart from
    // `Set Authorization: Bearer <token>` prose, since both start the
    // clause with the same word.  The giveaway is the SECOND word: a real
    // invocation's is always an option flag.
    const HEADER = "Auth" + "orization";
    const SCHEME = "Bea" + "rer";
    for (const flag of ["--", "-x", "-e"]) {
      const line = `set ${flag} ${HEADER}: ${SCHEME} password`;
      const out = redactSecretsInText(line);
      expect(out, line).toMatch(/«redacted \d+ chars»/);
      expect(out, line).not.toMatch(/password$/);
    }
    // genuine prose — no flag right after `set` — still exempts
    const doc = `set ${HEADER}: ${SCHEME} password`;
    expect(redactSecretsInText(doc), doc).toBe(doc);
  });

  it("does not let a case-arm's pattern-closing paren end a $(...) substitution early", () => {
    // A `case` arm's pattern is closed by a BARE `)` with NO matching `(`
    // at all — `case x in x) printf foo;; esac` is valid inside `$(…)`
    // (`help case`, confirmed against bash 5.2.21) — so counting that `)`
    // as this `$(…)`'s own close reads shell grammar as balancing.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    const url = " https://example.com";
    const line = `curl -H "${HEADER}: OAuth realm="$(case x in x) printf foo;; esac)", oauth_signature=${sig}"${url}`;
    const out = redactSecretsInText(line);
    expect(out).not.toContain(sig);
    expect(out).not.toContain("oauth_signature");
    expect(out).not.toContain("realm");
    expect(out).toContain("OAuth «redacted");
    expect(out).toContain(url);
    expect(out).toBe(redactSecretsInText(out));

    // multiple arms, and a nested case, both still balance correctly
    const multiArm = redactSecretsInText(
      `curl -H "${HEADER}: OAuth realm="$(case x in a) case y in b) cmd;; esac;; c) other;; esac)", oauth_signature=${sig}"${url}`,
    );
    expect(multiArm).not.toContain(sig);
    expect(multiArm).not.toContain("oauth_signature");
    expect(multiArm).toContain(url);
  });

  it("does not crash on thousands of nested $(...) expansions", () => {
    // Untrusted bot/tool output can hand redactSecretsInText a line with
    // roughly 5,000 nested `$(` openers.  Recursing into every one of them
    // overflows the call stack and throws, which aborts redaction (and,
    // through Bus.publish, ordinary event processing) instead of merely
    // losing diagnostic precision — the fix is a bounded recursion depth,
    // not perfect accuracy at a depth no real shell command would ever use.
    const HEADER = "Auth" + "orization";
    const sig = `FAKESIG${"0123456789".repeat(20)}`;
    let deep = "a";
    for (let i = 0; i < 5000; i++) deep = `$(echo ${deep})`;
    const line = `curl -H "${HEADER}: OAuth realm="${deep}", oauth_signature=${sig}" https://example.com`;
    let out = "";
    expect(() => {
      out = redactSecretsInText(line);
    }).not.toThrow();
    expect(out).not.toContain(sig);
  });
});
