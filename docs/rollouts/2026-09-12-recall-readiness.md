# Fleet RAG Routing And Readiness

Updated September 12, 2026, 2:30 AM Central.  Issues #271 and #272 track this follow-up to the September 9 audit.

An explicit recall service URL now selects that service for both the connection probe and bot tools.  With no URL, the host recall CLI is used when available.  A failed operation stays on its selected transport, so an ambiguous contribution is never retried against a different corpus.  The selected collection is passed to the CLI; a configured HTTP collection is checked against protected service statistics before sending search or contribution content.

Public health alone cannot establish readiness.  The protected `/recall/stats` response must identify the expected collection, a valid point count, and a healthy backend or embedder.  Backend failure, protected 401/403/404/500, invalid statistics, a collection mismatch, or a deadline produces `degraded`, with a reason.  An empty healthy corpus remains valid.  Raw database collection listings do not prove recall tool capability.

Status probes share one 12-second budget across the complete operation.  Simultaneous probes for the same configuration share a request, and a later failure retains the last successful timestamp for that configuration.  Bot tools use one 30-second budget.  A hung local CLI is terminated with its owned process group on POSIX, and its output pipes cannot keep the request pending after the deadline.

Same-origin redirects and a same-host HTTP-to-HTTPS upgrade are supported.  A redirect to another origin or an Access login path is not followed, preventing custom Cloudflare Access credentials from being forwarded to that destination.  Search and contribution responses are validated before success is reported.

## Validation And Acceptance

- HTTP fixtures cover protected 401/403/404/500, timeouts, unhealthy backends, invalid statistics, empty collections, mismatched collections, credential boundaries, and same-origin redirects.
- Process fixtures cover selected collection propagation and CLI/output-pipe deadlines.
- The harness integration fixture proves an explicit URL wins even when a healthy local CLI is present.
- On this Mac with Tailscale off, the updated proxy reported a healthy `fleet-agents` corpus with 40,980 points, and a semantic search returned a hybrid/reranked result in 2.12 seconds.  This was a read-only source-level probe; it is not a deployed-app receipt.
- Frontend route/state/last-success display and failed-save feedback are being completed in the renderer lane.  Signed Mac rollout and deployed connection checks remain under #274.

The long-lived Codex fleet-recall connector timed out after 300 seconds while a fresh stdio process returned healthy statistics immediately.  These are separate client-session and service observations; the timeout is not evidence that the corpus was down.
