# OpenAI-Compatible Tool Loop And Usage

The OpenAI-compatible engine now owns the complete model-to-tool loop, using the same bounded loop as MiniMax.  A user turn emits one terminal event, executes tool calls through the shared host and approval broker, and retains a stable transcript prefix between model rounds.  The obsolete harness executor and its 60-second listener timeout have been removed.

Streaming requests explicitly ask for usage.  Endpoints explicitly rejecting the optional usage field get one retry without it, using the same cancellation and deadline budget.  Other errors retain their typed HTTP classification without exposing upstream bodies.  Failed streams retain usage on Sentry chat spans, and actual tool lifecycle events provide the sole tool spans.  Reported input, output, and cached-input tokens survive model rounds and an upstream streaming error; cached input remains a subset of input.  Upstream error frames fail the turn instead of completing successfully, and their private body is excluded from the new error message.  Direct Grok also requests streamed usage, sums reported usage once per retry attempt, retains cached tokens on failed streams, and fails unsupported tool calls truthfully.  Both API adapters use the same usage normalization; native diagnostics retain routing and size metadata rather than prompt/reply bodies.

## Validation

- 123 focused Grok, OpenAI-compatible, shared-loop, and Sentry tests passed after review fixes.
- Three real-harness room checks passed for MiniMax, OpenAI-compatible, and direct Grok.
- An earlier overlapping run of OpenAI-compatible, Grok, and turn-tool tests passed 40 tests.
- Regression coverage checks one terminal event, approval routing, two-round usage totals, cached input, stream options, failed-stream usage, and credential isolation.
- `git diff --check` passed.  The previous head passed the complete hosted gate; current-head typecheck and the full test chain remain required before merge.
- No live provider request, subscription quota use, or Mac deployment is claimed by these fixture tests.
