# Plugin Author Template

This folder is the **author template**.  Copy it (and the matching
`botfleet-plugin.json`) into your own project to start a new plugin.
The same files live in `tests/fixtures/example-plugin/` so the lifecycle
tests have a real plugin to exercise.

## Layout

```
your-plugin/
  botfleet-plugin.json   <- the manifest
  plugin.mjs             <- the entry the manifest declares
  (any other files you import)
```

The manifest declares:

*   `name` (slug, unique), `version` (semver), `description`
*   `botfleet` (host API version constraint)
*   `entry` (path to the entry file, relative to the plugin root)
*   `capabilities` you need
*   `contributes.cards` and `contributes.commands`

## Authoring Rules

*   **No network unless you declare it.**  The sandbox denies every
    outbound connection.  To open a destination, add the `net.hosts`
    capability and list each `host:port` in `needs.network`:

    ```json
    "capabilities": ["net.hosts"],
    "needs": { "network": ["chat.example.com:443"] }
    ```

    Anything else is blocked.  The manager shows the list before a
    person enables the plugin.  The shipped Zulip plugin is the
    exception: the host also allows that install's configured realm.
*   **No files outside the plugin directory.**  Your plugin runs in its
    own sandboxed process that can read only its own directory and
    cannot write anywhere.
*   **No host state mutation.**  `host` is frozen and the only side
    effect is `host.log()`.  Log text stays inside your plugin's
    process; BotFleet records only the level and length.
*   **Return data, not UI.**  The host renders cards.  Plugins return
    JSON values; the host shapes the UI around them.

## Trust Model

Imports land **disabled**.  A user enables the plugin only after
reading the manifest.  Be conservative: an import that asks for
`read.bots` and renders a card is easier to trust than one that asks
for everything and renders a chat sidebar.

## Testing

Drop your plugin folder into `tests/fixtures/example-plugin/` (or a
new folder under `tests/fixtures/`) and add a lifecycle test in
`server/plugins.test.ts` that exercises install, enable, host API,
update, disable, remove.