# BotFleet Plugins

Plugins add cards and slash commands to BotFleet without waiting for an app update.  You install them from the **Plugins** screen in the sidebar.

## What You Need

Each plugin is a folder that contains a `botfleet-plugin.json` file.  That file describes the plugin's name, what it does, and what it can read inside BotFleet.

## Install a Plugin

1.  Open **Plugins** in the sidebar.
2.  Point BotFleet at the plugin folder using any of these:
    *   Click **Open** and choose the folder in Finder.
    *   Drag the plugin folder onto the BotFleet window while the Plugins screen is open.
    *   Paste a folder path, a GitHub link (`owner/repo`), or a full repository URL into the field, then click **Install**.

BotFleet copies or downloads the plugin, checks the description file, and adds it to your list.  New installs start **disabled** so you can read what the plugin does before turning it on.

## Enable or Turn Off a Plugin

Use **Enable** or **Disable** on each row.  Disabled plugins stay installed but do not run.

## Update or Remove

*   **Update** fetches a newer version when the plugin came from GitHub.
*   **Remove** deletes the installed copy from this Mac.

## Trust

Plugins run in a separate process and only see what their description file asks for.  Read the capabilities listed on each plugin before you enable it.  Only install plugins from people and sources you trust.

## Example

The repository includes a small example plugin under `docs/plugins/example-plugin/` for authors.  You can install that folder locally to see how the list and cards behave.
