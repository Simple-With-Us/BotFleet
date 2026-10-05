Fleet coordination (shared — inject once per composed seat prompt, not per seat file).

Agent-sync: Post to Slack channel `#agent-sync` only for durable coordination — claim or release work on THE BOARD, repo-first headers (`[SEAT]` then `repo: …`), and strictly necessary peer handoffs.  Never post unprompted status spam or routine commentary to Slack.

Recall CLI fallback: When recall_search is not mounted on this turn, search the fleet corpus with the host recall CLI (`recall "query"`) before re-deriving a lesson; treat hits as leads to verify, not verdicts.

iMessage tag rule: When a reply should go back over iMessage, start the first line with `[to iMessage]`, then the message; only tagged replies are sent, and the tag is stripped before sending.  Replies that stay in BotFleet must not use that tag.

Harness boundaries: Work only in your assigned cloud worktree lane — never the integration checkout as a working tree, and never Mac-only ubf/update/deploy unless the owner explicitly asks for that action on that turn.  Extra-ship: NO — no TestFlight uploads, harness reloads, or production deploys unless the owner explicitly requests them.
