# Native DeepSeek Harness ACP

## Source Change

Issue #188 now targets the current official `@deepseek-ai/dsh` ACP profile instead of the obsolete private bridge plan.  The driver starts `dsh --profile acp`, sends standard MCP declarations through `session/new` or `session/resume`, selects the full `deepseek-official` model route through `session/set_config_option`, and verifies the returned model before prompting.  Reasoning choices map BotFleet `none` to DSH `off` and preserve native `high` and `max` values.

The shared ACP core now lets a provider declare its resume method, encode an opaque model-option value, and reject an incompatible stock CLI both in its setup snapshot and immediately before dispatch.  Existing ACP providers keep their previous defaults.  DSH requires 0.1.5-rc.1 or newer because that is the first compatible native profile; a custom operator wrapper remains outside the stock-binary version policy.  Authentication readiness recognizes only `DEEPSEEK_API_KEY` or the published DSH credential file at `$DSH_HOME/.credentials.yaml` (defaulting to `~/.dsh/.credentials.yaml`), so credentials belonging to other DeepSeek clients cannot produce a false ready state.

The upstream [ACP profile guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md) documents `dsh --profile acp`, standard stdio and HTTP MCP declarations, `session/resume`, model and `reasoning_effort` options, semantic updates, and one-shot permission decisions.  The upstream [model-control implementation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/model-control.ts) defines the opaque `[provider, model]` selector and the returned-state confirmation used here.  On September 12, 2026, the npm registry reported `@deepseek-ai/dsh@0.1.5-rc.1` as `latest` and `0.1.5-rc.2` as `next`.

## Validation Boundary

The fake native ACP process covers exact spawn arguments, standard MCP transport, model and reasoning confirmation, resume without transcript replay, permission requests, semantic text/tool updates, cancellation, and error classification.  Focused DSH plus shared ACP tests passed 64/64 after current-main integration, including the stock CLI dispatch gate.

This Mac has no `dsh` executable on `PATH`, so no real installed-binary handshake or paid model turn was claimed.  Installing or changing the live DSH runtime remains outside this source lane.  The final full BotFleet gate, hosted CI, merge, and live setup acceptance remain pending.

Live adoption must replace the existing custom `dsh-acp` bridge with the compatible stock package and profile in one coordinated configuration change.  Leaving the old bridge path selected would keep its previous model, resume, and MCP limits even after this source ships.
