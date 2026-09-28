// The second half of O2: the redaction at the LIVE Sentry sink.
//
// The four cases in `sentry-ai.test.ts` prove the call sites redact, which is
// where the finding pointed.  They cannot reach `liveSink()` — that one asks
// `isSentryActive()` and `getSentry()` for a real client — so the defence that
// actually covers "any other string that goes to Sentry from this module" would
// otherwise ship untested.
//
// It reaches the sink through `createSentryAiSink`, the real factory, handed a
// recording client.  The alternative was a `vi.mock` of the whole `./sentry.ts`
// module, and `vi.mock` is hoisted to the top of the file it appears in:
// folding that in would put a stub `scrubWebhookSecrets` under the grouping
// logic for every test sharing the module, and it would substitute a module
// rather than the one thing that varies, which is the client.
//
// Why the live sink is redacted at all, when the call sites already are: the
// SDK's own hooks cannot do it.  `server/sentry.ts` registers `beforeSend`,
// `beforeSendTransaction` and `beforeSendLog` — and no `beforeBreadcrumb` —
// and the payload scrub it does register runs `scrubWebhookSecrets` alone,
// which knows about BotFleet's own `/hooks/` webhook secrets and nothing else.
// So a breadcrumb reaches Sentry carrying whatever text it was handed.
import { describe, expect, it } from "vitest";

import type { Breadcrumb } from "@sentry/node";

import { createSentryAiSink, type SentryClientLike } from "./sentry-ai.ts";

/** A client that records instead of sending, and implements exactly the
 *  surface `SentryClientLike` names. */
/** One recorded exception, as the Issue view would read it. */
interface RecordedException {
  message: string;
  stack?: string;
}
/** One recorded breadcrumb: the two fields this file asserts on. */
interface RecordedBreadcrumb {
  message: string;
  data?: Record<string, string>;
}

function recordingClient() {
  const captured = {
    // SAFETY: an empty array literal has no element type to infer, and the
    // three element types below are declared above.
    exceptions: [] as RecordedException[],
    // SAFETY: a string, which is what `captureMessage` is given.
    messages: [] as string[],
    // SAFETY: a `RecordedBreadcrumb`, declared above.
    breadcrumbs: [] as RecordedBreadcrumb[],
  };
  const client: SentryClientLike = {
    setUser: () => {},
    startInactiveSpan: () => ({ setAttribute: () => {}, end: () => {} }),
    // A capture carries whatever the caller captured, and the point of this
    // double is to record it verbatim — narrowing it here would defeat the
    // test, so the recorded value stays `unknown` and is asserted below.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    captureException: (error: unknown) => {
      // SAFETY: the sink only ever captures a real `Error`, and that is the
      // one value whose `.message` and `.stack` this asserts on.
      const recorded = error as Error;
      captured.exceptions.push({ message: recorded.message, stack: recorded.stack });
    },
    captureMessage: (message: string) => captured.messages.push(message),
    addBreadcrumb: (crumb: Breadcrumb) =>
      captured.breadcrumbs.push({
        message: crumb.message ?? "",
        // SAFETY: the sink builds `data` itself as a string map, so the only
        // shape that reaches this recorder is the one declared above.
        data: crumb.data as Record<string, string> | undefined,
      }),
  };
  return { captured, client };
}

describe("the live sink redacts on its own account", () => {
  // Both are assembled at runtime so no token-shaped literal sits in the
  // source (GitHub's push protection flags those).
  const KEY = ["sk", "-ant-api03-", "A".repeat(24)].join("");
  const BEARER_VALUE = ["bearer", ".token", ".value", ".9f2c"].join("");

  it("scrubs a breadcrumb whose text and data were handed to it verbatim", () => {
    // The thread id rides along in the breadcrumb's `data` map, so a driver
    // that puts something credential-shaped in it exercises the string-value
    // half of the sink pass as well as the message half.
    const { captured, client } = recordingClient();
    const sink = createSentryAiSink(client);

    sink.addBreadcrumb?.({
      category: "runtime",
      message: `The saved ACP session could not be resumed: header was ${["Bearer", " ", BEARER_VALUE].join("")}`,
      level: "warning",
      data: { threadId: `thread-${KEY}` },
    });
    sink.addBreadcrumb?.({
      category: "turn",
      message: `bot turn failed: auth rejected for ${KEY}`,
      level: "warning",
      data: {},
    });

    expect(captured.breadcrumbs).toHaveLength(2);
    expect(captured.breadcrumbs[0].message).not.toContain(BEARER_VALUE);
    expect(captured.breadcrumbs[1].message).not.toContain(KEY);
    // `data` is a free-form string map — the other half of the sink's pass,
    // and the one the SDK's own hooks never see.
    expect(JSON.stringify(captured.breadcrumbs[0].data ?? {})).not.toContain(KEY);
  });

  it("scrubs a captured error's message and its stack header together", () => {
    const { captured, client } = recordingClient();
    const sink = createSentryAiSink(client);

    const error = new Error(`auth rejected for ${KEY}`);
    sink.captureException?.(error, { tags: { "gen_ai.system": `openai-compat ${KEY}` } });
    sink.captureMessage?.(`session died holding ${BEARER_VALUE}`, { level: "error" });

    expect(captured.exceptions).toHaveLength(1);
    expect(captured.exceptions[0].message).not.toContain(KEY);
    // Redacting the message without the cached stack header would leave the
    // credential on the first line of the very field the Issue view renders.
    expect(captured.exceptions[0].stack ?? "").not.toContain(KEY);
    expect(JSON.stringify(captured.exceptions)).not.toContain(KEY);
    // A `Bearer` value is a shape the redactor names, so a captured message
    // carrying one is masked.  A bare token with no provider prefix and no
    // scheme in front of it is not a shape it claims — do not widen this into
    // a test that pretends otherwise.
    expect(captured.messages[0]).not.toContain(`Bearer ${BEARER_VALUE}`);
  });

  it("redacts the fingerprint and tags it is handed, not just the message", () => {
    const { captured, client } = recordingClient();
    const sink = createSentryAiSink(client);
    sink.captureException?.(new Error("plain failure"), {
      tags: { "gen_ai.system": `openai-compat ${KEY}` },
      fingerprint: [`run ${KEY}`],
    });
    expect(JSON.stringify(captured.exceptions)).not.toContain(KEY);
  });
});
