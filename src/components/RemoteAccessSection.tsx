import { useState } from "react";
import {
  COMPANION_GATEWAY_BLURB,
  COMPANION_GATEWAY_LABEL,
  normalizeRemoteUrl,
  REMOTE_ACCESS_BLURB,
  REMOTE_ACCESS_HEADING,
  REMOTE_ACCESS_UNCONFIGURED_BLURB,
  REMOTE_URL_LABEL,
  sentenceGapHtml,
} from "@/lib/remote-access";
import { Card, CopyableValue } from "./SettingsPrimitives";

export type RemoteAccessTestResult =
  | { kind: "running" }
  | { kind: "ok"; label: string; detail?: string; tunnel?: string }
  | { kind: "error"; label: string; detail?: string; tunnel?: string };

const PRODUCT_REACHABLE = "Reachable";
const PRODUCT_TIMEOUT = "The request timed out.";
const PRODUCT_UNREACHABLE = "Couldn't reach this Mac.";

/**
 * Product pill copy for Settings.  Probe/shim telemetry stays on `detail`
 * (title/hover) and must never become the visible label.
 */
function mapIngressProbeCopy(
  kind: "ok" | "error",
  raw: string | undefined,
  tunnel?: string,
): Extract<RemoteAccessTestResult, { kind: "ok" | "error" }> {
  const detail = typeof raw === "string" ? raw : "";
  const haystack = detail.toLowerCase();
  const timedOut =
    haystack.includes("timeout") || haystack.includes("timed out") || haystack.includes("aborted");
  const label = kind === "ok" ? PRODUCT_REACHABLE : timedOut ? PRODUCT_TIMEOUT : PRODUCT_UNREACHABLE;
  return {
    kind,
    label,
    ...(detail ? { detail } : {}),
    ...(tunnel ? { tunnel } : {}),
  };
}

/**
 * Turns a raw /api/ingress/test fetch outcome into a RemoteAccessTestResult.
 *
 * A successful response carries an IngressProbeResult ({ ok, reason, tunnel? }).
 * A non-2xx response does NOT: when the packaged renderer talks through the
 * attached-UI shim (electron/attached-ui-shim.mjs proxyHttp) and the local
 * harness is unreachable, the shim answers with its own HTTP 502 and a plain
 * { error: string } body. Casting that shape to IngressProbeResult reads a
 * falsey `ok` and an undefined `reason`, so the control would display a blank
 * error exactly when there is something useful to say. Check response.ok
 * first and keep the shim's `error` (or the status fallback) as hover `detail`.
 *
 * Visible copy is product-only: Reachable / The request timed out. /
 * Couldn't reach this Mac.
 */
export function describeIngressTestOutcome(
  ok: boolean,
  status: number,
  body: unknown,
): RemoteAccessTestResult {
  if (!ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined;
    return mapIngressProbeCopy("error", error ?? `Request failed with status ${status}`);
  }
  const parsed = body as { ok: boolean; reason: string; tunnel?: string };
  return parsed.ok
    ? mapIngressProbeCopy("ok", parsed.reason, parsed.tunnel)
    : mapIngressProbeCopy("error", parsed.reason, parsed.tunnel);
}

const buttonSecondary =
  "rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent";

/**
 * The button + status region, split out so its accessible-name and live-region
 * behavior across all three test states (idle/running/done) can be unit
 * tested without driving a real fetch through RemoteAccessSection.
 */
export function TestConnectionControl({
  test,
  onRunTest,
}: {
  test: RemoteAccessTestResult | null;
  onRunTest: () => void;
}) {
  const running = test?.kind === "running";
  return (
    <>
      <button
        onClick={onRunTest}
        disabled={running}
        // Accessible name must match the visible chrome: "Test Connection"
        // idle, "Testing…" while the five-second probe runs. A mismatched
        // aria-label ("Test Remote Access") announced a different name than
        // the button on screen. Keep aria-busy so the busy state is exposed
        // independently of the label swap.
        aria-label={running ? "Testing…" : "Test Connection"}
        aria-busy={running}
        className={buttonSecondary}
      >
        {running ? "Testing…" : "Test Connection"}
      </button>
      {test ? (
        running ? (
          <span role="status" aria-live="polite" className="text-[12px] leading-relaxed text-ink-secondary">
            Testing connection…
          </span>
        ) : (
          <span
            role={test.kind === "ok" ? "status" : "alert"}
            aria-live="polite"
            data-testid="remote-access-test-result"
            title={test.detail}
            className={`text-[12px] leading-relaxed ${test.kind === "ok" ? "text-success" : "text-danger"}`}
          >
            {test.label}
          </span>
        )
      ) : null}
    </>
  );
}

export function RemoteAccessSection({ configuredUrl, highlightClass }: { configuredUrl?: string | null; highlightClass?: (domId: string) => string | undefined }) {
  const [test, setTest] = useState<RemoteAccessTestResult | null>(null);
  // This install's own address, or null.  There is no fallback host: an
  // install that has not configured remote access gets the setup sentence
  // and no probe button, rather than a link into somebody else's tunnel.
  const remoteUrl = normalizeRemoteUrl(configuredUrl);

  const runTest = async () => {
    if (!remoteUrl) return;
    setTest({ kind: "running" });
    try {
      // Probe /api/health, not the bare root: a tunnel commonly protects
      // everything behind it except that one path, so a bare-root probe
      // would just follow the redirect to the tunnel's login page and
      // report HTTP 200 even when the tunnel or the BotFleet origin behind
      // it is down.  /api/health is public and probeIngressUrl requires its
      // real BotFleet payload for this exact path.
      const response = await fetch("/api/ingress/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicUrl: `${remoteUrl}/api/health` }),
      });
      const body = await response.json().catch(() => null);
      setTest(describeIngressTestOutcome(response.ok, response.status, body));
    } catch (cause) {
      setTest(mapIngressProbeCopy("error", cause instanceof Error ? cause.message : String(cause)));
    }
  };

  if (!remoteUrl) {
    return <Card id="setting-remote-access" className={highlightClass?.("setting-remote-access")} title={REMOTE_ACCESS_HEADING} subtitle={sentenceGapHtml(REMOTE_ACCESS_UNCONFIGURED_BLURB)} />;
  }

  return (
    <Card id="setting-remote-access" className={highlightClass?.("setting-remote-access")} title={REMOTE_ACCESS_HEADING} subtitle={sentenceGapHtml(REMOTE_ACCESS_BLURB)}>
      <div className="flex flex-col gap-3">
        <CopyableValue label={REMOTE_URL_LABEL} value={remoteUrl} />
        <div className="flex flex-wrap items-center gap-3">
          <TestConnectionControl test={test} onRunTest={() => void runTest()} />
        </div>
      </div>
    </Card>
  );
}

export function CompanionGatewayCard() {
  return <Card title={COMPANION_GATEWAY_LABEL} subtitle={sentenceGapHtml(COMPANION_GATEWAY_BLURB)} />;
}

