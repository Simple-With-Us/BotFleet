import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { z } from "zod";

export interface CliCredentialSyncToolResult {
  name: string;
  paths: string[];
}

export interface CliCredentialSyncSkip {
  name: string;
  reason: string;
}

export interface CliCredentialSyncResult {
  ok: boolean;
  syncedTools: CliCredentialSyncToolResult[];
  skippedTools: CliCredentialSyncSkip[];
  containerName: string;
}

const cliCredentialSyncResultSchema = z.object({
  ok: z.boolean(),
  syncedTools: z.array(
    z.object({
      name: z.string(),
      paths: z.array(z.string()),
    }),
  ),
  skippedTools: z.array(
    z.object({
      name: z.string(),
      reason: z.string(),
    }),
  ),
  containerName: z.string(),
});

export function CliCredentialSyncPanel({
  syncUrl,
  title = "Host CLI Credentials",
  description,
  autoSyncEnabled,
  disabled,
  disabledReason,
}: {
  syncUrl: string;
  title?: string;
  description: string;
  autoSyncEnabled?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<CliCredentialSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const handleSyncCredentials = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const response = await fetch(syncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = z.object({ error: z.string() }).safeParse(data);
        throw new Error(errorMessage.success ? errorMessage.data.error : `Sync failed (${response.status})`);
      }
      const parsed = cliCredentialSyncResultSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error("Sync returned an unexpected response shape");
      }
      setSyncResult(parsed.data);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const blocked = Boolean(disabled);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-hairline/40 bg-surface-subtle/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">{title}</div>
          <div className="text-[12px] text-ink-secondary">
            {description}
            {autoSyncEnabled ? "\u00a0 Automatic sync is enabled in Host & CLI Integration." : ""}
          </div>
          {blocked && disabledReason && (
            <div className="mt-1 text-[12px] text-ink-secondary">{disabledReason}</div>
          )}
        </div>
        <button
          type="button"
          disabled={syncing || blocked}
          onClick={() => void handleSyncCredentials()}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/60 bg-control px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control/80 disabled:opacity-50"
        >
          {syncing ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Syncing...
            </>
          ) : (
            <>Sync CLI Credentials</>
          )}
        </button>
      </div>
      {syncResult && (
        <div className="flex flex-col gap-1 text-[12px]">
          {syncResult.syncedTools.length > 0 ? (
            <div className="flex items-start gap-2 text-success">
              <Check size={13} className="mt-0.5 shrink-0" />
              <span>
                Synced {syncResult.syncedTools.length} tool(s):{" "}
                {syncResult.syncedTools.map((entry) => entry.name).join(", ")}
              </span>
            </div>
          ) : (
            <div className="text-ink-secondary">No local CLI credentials found to sync.</div>
          )}
          {syncResult.skippedTools.length > 0 && (
            <div className="text-ink-secondary">
              Skipped {syncResult.skippedTools.length} tool(s):{" "}
              {syncResult.skippedTools.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}
            </div>
          )}
        </div>
      )}
      {syncError && (
        <div className="flex items-center gap-2 text-[12px] text-danger">
          <AlertTriangle size={13} className="shrink-0" />
          <span>{syncError}</span>
        </div>
      )}
    </div>
  );
}
