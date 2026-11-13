# Provider Request Isolation

## Scope

Issues #278 and #279 isolate provider request context per bot.  Claude no longer imports the user’s global `~/.claude.json` MCP servers, and every Claude turn passes a strict MCP config containing only the bot’s selected integrations.  Grok builds one chat-completions message list from the system prompt, transcript, tool history, and current prompt.

Claude title generation and permission review also pass an empty strict MCP config and disable built-in tools.  Prompts stay on stdin.  A bounded `--help` capability probe prevents Settings from advertising a CLI without verified strict MCP support as available.  Successful probes are cached per detected CLI version; failures expire after 30 seconds.  Bot turns and one-shot helpers enforce the same cached capability result before launch, including when Settings has not probed the instance.  Later calls reuse that result without another subprocess.  Stop during the initial probe prevents the turn from launching.  Every launch retains the strict flag so unsupported CLIs fail closed.

## Validation

- `pnpm exec vitest run server/drivers/claude.test.ts server/drivers/grok.test.ts`: 74 passed, 1 skipped after the capability and helper fixes.
- `pnpm typecheck`: passed after the launch-guard follow-up.
- Full `pnpm typecheck && pnpm test`: passed after the final launch guard (3,491 Vitest tests passed, 19 skipped, plus all chained suites).
- Hosted macOS, Linux, Windows, control-plane, Linux package, Swift and iOS build gates passed at `65ed1b57`; final follow-up CI must pass before merge.
- Final Windows CI exposed a POSIX-only crashing-CLI fixture in the existing real-server failover test.  Replaced it with the same Node wrapper used by the engine-safety lane; the focused failover regression and typecheck passed.
- A hosted exact-minute quota display test failure was fixed by freezing its clock; product quota behavior is unchanged.

## Rollout

Deploy only with a Claude CLI that advertises `--strict-mcp-config`; unsupported or unresponsive capability probes show upgrade guidance.  The focused fake CLI verifies argument/config isolation and version-aware probe caching.  No paid inference or manual runtime restart was performed; deployed CLI acceptance remains a separate check.  The documented CLI contract is [Anthropic's CLI reference](https://code.claude.com/docs/en/cli-reference).
