-- Persist Composio Session upgrade attempts so cold isolates do not recreate
-- Sessions forever when the upstream Session still lacks multi-account.
ALTER TABLE installations ADD COLUMN session_upgrade_attempted INTEGER NOT NULL DEFAULT 0;
