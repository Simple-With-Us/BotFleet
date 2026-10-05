// Host & CLI Integration — the two workspace toggles that apply to EVERY VM a
// bot can use (the Local VM and the Shared VPS), so they live in a card of
// their own rather than inside the Local VM runtime card.  Each toggle saves
// as soon as it is clicked, shows that it is saving, and reports its own
// failure here: a save that fails must never leave a box that looks ticked.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { productErrorHeadline } from "@/lib/product-error";

type VmToggle = "shareCliCredentials" | "allowHostTerminal";

export function HostCliIntegrationCard() {
  const { state, dispatch } = useStore();
  const [saving, setSaving] = useState<VmToggle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const localVm = state.config?.localVm;

  const save = (key: VmToggle, value: boolean) => {
    setSaving(key);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ localVm: { [key]: value } }),
    })
      .then((config: ConfigStatus) => {
        dispatch({ type: "configStatus", config });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(null));
  };

  const rows: Array<{ key: VmToggle; title: string; body: string }> = [
    {
      key: "shareCliCredentials",
      title: "Share Host CLI Credentials with Local & Cloud VMs",
      body:
        "Makes your host CLI credentials (~/.infisical, ~/.ssh, ~/.docker, ~/.gitconfig, ~/.config/gh, ~/.aws, ~/.config/gcloud, ~/.npmrc, etc.) available read-only, so tools run inside a VM are signed into your accounts.\u00a0 " +
        "The Shared VPS is synced automatically when a bot starts a turn, at most once every ten minutes.\u00a0 " +
        "A Local VM mounts them when it is created, so recreate an existing Local VM to pick this up.",
    },
    {
      key: "allowHostTerminal",
      title: "Host Shell Execution with VM Screen (Hybrid Mode)",
      body:
        "Lets bots using a Local VM or the Shared VPS run shell commands and tests in your host Mac terminal, while every mouse click, keystroke, and desktop view stays strictly inside the VM.",
    },
  ];

  return (
    <Card
      id="setting-computers-cli-credentials"
      title="Host & CLI Integration"
      subtitle="Manage CLI authentication and terminal access for bots using Local and Cloud VMs."
    >
      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <label key={row.key} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(localVm?.[row.key])}
              disabled={saving === row.key}
              onChange={(e) => save(row.key, e.target.checked)}
              className="mt-0.5 rounded border-hairline/40 accent-accent"
            />
            <div className="text-[13px]">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                {row.title}
                {saving === row.key && <Loader2 size={12} className="animate-spin" aria-label="Saving" />}
              </div>
              <div className="text-[12px] text-ink-secondary">{row.body}</div>
            </div>
          </label>
        ))}
        {error && (
          <div className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger" title={error}>
            {productErrorHeadline(error)}
          </div>
        )}
      </div>
    </Card>
  );
}
