// Engines settings — per-instance CLI path override. One "Set CLI…" button
// per engine reveals a picker: a "detected" dropdown of every binary the
// server found on PATH, plus a manual path input. Saving first probes the
// binary (`<cli> --version`, same PATH a real turn uses); a failed probe
// asks before registering — the classic miss is a path the terminal sees
// but this GUI app can't.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, TriangleAlert, Upload, X } from "lucide-react";

import { api, useStore, type InstanceInfo } from "@/state/store";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { EngineCallout } from "./EngineCallout";
import { EngineCapabilitiesMatrix } from "./EngineCapabilitiesMatrix";
import { ProviderMark } from "./ProviderIcons";
import { splitEngineRail } from "@/lib/engine-rail";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  ADD_ENGINE_DRIVERS,
  addEngineDriverOption,
  createCustomEngine,
  customEngineCalloutTitle,
  deleteCustomEngine,
  isCustomEngineInstance,
  validateAddEngine,
  type EngineCredentialDeps,
} from "@/lib/custom-engine";

interface ProbeResult {
  ok: boolean;
  version?: string;
  message?: string;
}

/** Default the toggle to ON when the persisted config never had the field
 * — the registry treats absent `enabled` as `true` and the UI must match. */
function isEngineEnabled(instance: InstanceInfo): boolean {
  return instance.enabled !== false;
}

/** Why an engine is not in the active rail.  `snapshot.reason` is the
 *  driver's own words whenever it supplies any; otherwise the three cases a
 *  reader can actually act on are separated out.  Nothing here is
 *  invented — a field the runtime does not set never produces a sentence. */
function engineUnavailableReason(instance: InstanceInfo): string {
  if (instance.snapshot.reason) return instance.snapshot.reason;
  if (instance.snapshot.state !== "available") {
    return "Command-line app not found on this computer.";
  }
  if (instance.snapshot.authenticated === false) return "Installed, but not signed in.";
  return "Turned off in Settings.";
}

/** Real deps for createCustomEngine/deleteCustomEngine (src/lib/custom-engine.ts),
 * built fresh per call so a bridge that appears or disappears between
 * renders (should never happen in practice, but window.ogb is read live
 * rather than cached) is always current. */
function buildEngineCredentialDeps(): EngineCredentialDeps {
  return {
    createInstance: (body, options) =>
      api(
        options?.secretStorage === "external" ? "/api/instances?secretStorage=external" : "/api/instances",
        { method: "POST", body: JSON.stringify(body) },
      ),
    deleteInstance: (instanceId) => api(`/api/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" }),
    setInstanceCredential: window.ogb?.setInstanceCredential
      ? (instanceId, value) => window.ogb!.setInstanceCredential!(instanceId, value)
      : undefined,
    clearInstanceCredential: window.ogb?.clearInstanceCredential
      ? (instanceId) => window.ogb!.clearInstanceCredential!(instanceId)
      : undefined,
  };
}

function CustomPicker({
  instance,
  cliDefault,
  isBusy,
  onClose,
  onSave,
}: {
  instance: InstanceInfo;
  cliDefault?: string;
  isBusy?: boolean;
  onClose: () => void;
  onSave: (cli: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [candidates, setCandidates] = useState<string[] | null>(instance.cliCandidates ?? null);
  // `selected` starts EMPTY, never at instance.cli: a wrapper override
  // ("/ag claude agp") has no matching <option>, and a select whose value
  // points at a missing option renders the placeholder while still holding
  // the ghost value — the form would look empty yet refuse to save.
  const [selected, setSelected] = useState<string>("");
  const [manual, setManual] = useState<string>(
    // the current override rides the manual input unless it is exactly a
    // detected path (then the dropdown preselects it below)
    instance.cli && !(instance.cliCandidates ?? []).includes(instance.cli) ? instance.cli : "",
  );
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  // The describe() snapshot can be stale (CLI installed since last refresh);
  // re-fetch candidates once when the picker mounts so the dropdown is current.
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    api(`/api/cli-candidates?name=${encodeURIComponent(cliDefault ?? "")}`)
      .then(({ candidates: found }: { candidates: string[] }) => {
        setCandidates(found);
        if (!instance.cli) return;
        // preselect a detected override in the dropdown; a non-detected one
        // (wrapper string, moved binary) rides the manual input instead
        if (found.includes(instance.cli)) setSelected(instance.cli);
        else setManual(instance.cli);
      })
      .catch(() => setCandidates((prev) => prev ?? []));
  }, [cliDefault, instance.cli]);

  const value = manual.trim() || selected;
  const dirty = value !== (instance.cli ?? "");
  const busy = probing || saving || Boolean(isBusy);

  // Editing the path invalidates a previous probe result.
  useEffect(() => {
    setProbe(null);
  }, [value]);

  const persist = () => {
    if (busy || !value || !dirty) return;
    setSaving(true);
    setError(null);
    const committed = value; // freeze: inputs disable during save, but the
    // closure must not see a later keystroke either
    onSave(committed)
      .then((res) => {
        if (res.ok) {
          onClose();
        } else {
          setError(res.error ?? "Failed to save CLI path");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const save = () => {
    if (busy || !value || !dirty) return;
    setProbing(true);
    setError(null);
    api("/api/cli-test", {
      method: "POST",
      body: JSON.stringify({ cli: value, driver: instance.driverKind }),
    })
      .then((result: ProbeResult) => {
        setProbe(result);
        // ok → save immediately; failed → hold for explicit confirmation
        if (result.ok) persist();
      })
      .catch((e) => setError(e.message))
      .finally(() => setProbing(false));
  };

  return (
    <div className="mt-2.5 flex flex-col gap-2">
      {candidates !== null && candidates.length > 0 && (
        <div className="relative">
          <select
            value={manual.trim() ? "" : selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setManual("");
            }}
            aria-label={`${instance.displayName} detected CLI`}
            disabled={busy}
            className="w-full appearance-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 pr-8 font-mono text-[12px] text-ink focus:border-hairline focus:outline-none disabled:opacity-50"
          >
            <option value="">Select a detected binary…</option>
            {candidates.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
        </div>
      )}
      <input
        type="text"
        value={manual}
        onChange={(e) => setManual(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (!value || !dirty) return; // nothing to save — same hint the disabled button gives
          save();
        }}
        placeholder={candidates?.length ? "Enter path manually…" : "/absolute/path/to/cli"}
        aria-label={`${instance.displayName} custom CLI path`}
        spellCheck={false}
        disabled={busy}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-hairline focus:outline-none disabled:opacity-50"
      />
      {probe && !probe.ok && probe.message && (
        <div role="alert" className="flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2.5 py-2 text-[12px] leading-relaxed text-warning">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            Test failed — {probe.message}
            {" "}Register this path anyway?
          </span>
        </div>
      )}
      {probe?.ok && probe.version && (
        <div className="text-[12px] text-success">Test passed — {probe.version}</div>
      )}
      {error && <div role="alert" className="text-[12px] text-danger">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
        {probe && !probe.ok ? (
          <>
            <button
              onClick={() => setProbe(null)}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised/50 hover:text-ink disabled:opacity-50"
            >
              Edit path
            </button>
            <button
              onClick={() => persist()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : "Save Anyway"}
            </button>
          </>
        ) : (
          <button
            onClick={save}
            disabled={busy || !value || !dirty}
            className={cn(
              "flex w-[72px] items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px]",
              "bg-raised text-ink hover:bg-raised-hover",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} />Save</>}
          </button>
        )}
      </div>
    </div>
  );
}

function EngineRow({
  instance,
  busyInstanceId,
  onPatch,
  reason,
}: {
  instance: InstanceInfo;
  busyInstanceId: string | null;
  onPatch: (
    patch: { cli?: string; fullAuto?: boolean; enabled?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** One line saying why this engine is not usable right now.  Rendered
   *  only where the panel knows the answer. */
  reason?: string;
}) {
  const { refreshInstances } = useStore();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenFor = useRef<string | null>(null);

  // A disabled engine keeps the same controls visible — ungrey them while
  // you flip the toggle back on is the right call — but none of them should
  // be *clickable*. Use the per-row `enabled` state, not the snapshot reason,
  // because a separately-disabled wildcard cooldown on an otherwise available
  // engine is the wrong gate (we want settings, not quotas, to block the row).
  const enabled = isEngineEnabled(instance);
  const isBusy = busyInstanceId !== null;
  const isThisBusy = busyInstanceId === instance.instanceId;
  const hasCli = instance.cli !== undefined || instance.cliDefault !== undefined;
  const isCustom = isCustomEngineInstance(instance);

  // Close the picker when this instance's override changes to anything else
  // — a save from this row, another tab, or the 5-min refresh. The picker
  // initialized its fields from the OLD value and never re-syncs, so staying
  // open would show stale state.
  useEffect(() => {
    if (wasOpenFor.current !== null && wasOpenFor.current !== instance.cli) {
      setOpen(false);
    }
    wasOpenFor.current = instance.cli ?? null;
  }, [instance.cli]);

  const patchWithLocalError = async (patch: { cli?: string; fullAuto?: boolean; enabled?: boolean }) => {
    setError(null);
    const res = await onPatch(patch);
    if (!res.ok && res.error) {
      setError(res.error);
    }
    return res;
  };

  const reset = () => {
    if (isBusy || !enabled || deleting) return;
    void patchWithLocalError({ cli: "" });
  };

  const deleteEngine = () => {
    if (isBusy || deleting) return;
    setConfirmDelete(true);
  };

  const confirmDeleteEngine = () => {
    if (isBusy || deleting) return;
    setConfirmDelete(false);
    setDeleting(true);
    setError(null);
    deleteCustomEngine(buildEngineCredentialDeps(), instance.instanceId)
      .then(({ credentialClearError }) =>
        Promise.resolve(refreshInstances({ fresh: true }))
          .catch(() => {})
          .then(() => {
            if (credentialClearError) {
              // NBSP, not two ASCII spaces — see createCustomEngine's own
              // note; same plain <div> below.
              setError(`Engine deleted.  Its stored key could not be cleared: ${credentialClearError}`);
            }
          }),
      )
      .catch((e: Error) => setError(e.message))
      .finally(() => setDeleting(false));
  };

  const toggleEnabled = (next: boolean) => {
    if (isBusy || deleting) return;
    void patchWithLocalError({ enabled: next });
  };

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px]">
        <label
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[11.5px] uppercase tracking-wide",
            enabled ? "text-ink-secondary cursor-pointer" : "text-ink-secondary/70 cursor-pointer",
            (isBusy || deleting) && "cursor-not-allowed opacity-60",
          )}
          title={enabled ? "Disable this engine" : "Enable this engine"}
        >
          <input
            type="checkbox"
            aria-label={`${instance.displayName} enabled`}
            className="accent-accent"
            checked={enabled}
            disabled={isBusy || deleting}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          {enabled ? "On" : "Off"}
        </label>
        <span className={cn("size-1.5 shrink-0 rounded-full", instance.cli ? "bg-accent" : "bg-raised-hover")} />
        <ProviderMark driverKind={instance.driverKind} size={18} iconUrl={instance.iconUrl} />
        <span className={cn("shrink-0 flex items-center gap-1.5", enabled ? "text-ink" : "text-ink-secondary/70")}>
          {instance.displayName}
          {isThisBusy && <Loader2 size={12} className="animate-spin text-accent" />}
        </span>
        {instance.cli ? (
          <span className={cn("truncate font-mono text-[11.5px]", enabled ? "text-accent" : "text-ink-secondary/60")} title={instance.cli}>
            {instance.cli}
          </span>
        ) : (
          instance.cliDefault && (
            <span className={cn("truncate text-[11px]", enabled ? "text-ink-secondary" : "text-ink-secondary/60")} title={`${instance.cliDefault} · default`}>{instance.cliDefault} · default</span>
          )
        )}
        <span className="flex-1" />
        {instance.cli && (
          <button
            onClick={reset}
            disabled={isBusy || !enabled || deleting}
            className="shrink-0 text-[11.5px] text-ink-secondary hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isThisBusy ? "Resetting…" : "Reset"}
          </button>
        )}
        <label className={cn(
          "flex items-center gap-1.5 shrink-0 text-[12px] text-ink-secondary",
          enabled && !isBusy && !deleting ? "hover:text-ink cursor-pointer" : "cursor-not-allowed opacity-60",
        )}>
          <input
            type="checkbox"
            className="accent-accent"
            checked={!!instance.fullAuto}
            disabled={isBusy || !enabled || deleting}
            onChange={(e) => void patchWithLocalError({ fullAuto: e.target.checked })}
          />
          Bypass permissions (autonomous mode)
        </label>
        {hasCli && (
          <button
            onClick={() => setOpen((v) => !v)}
            disabled={!enabled || isBusy || deleting}
            aria-expanded={open}
            className={cn(
              "shrink-0 rounded-lg border border-hairline/40 px-3 py-1 text-[12px]",
              !enabled || isBusy || deleting
                ? "cursor-not-allowed opacity-40"
                : open
                  ? "bg-accent/15 text-accent"
                  : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
            )}
          >
            Set CLI…
          </button>
        )}
        {isCustom && (
          <button
            type="button"
            onClick={deleteEngine}
            disabled={isBusy || deleting}
            className="shrink-0 rounded-lg border border-danger/30 px-2.5 py-1 text-[12px] text-danger hover:bg-danger/10 disabled:opacity-40"
            title="Delete this custom engine"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
      </div>
      {reason && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary/70">{reason}</p>
      )}
      {instance.driverKind === "antigravityAgent" && (
        <div className="mt-2 rounded bg-raised/40 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-hairline/40">
          Antigravity's print mode has no approval cards.  With the bypass off, file edits go through and shell
          commands are refused.  With it on, every tool runs on this computer without asking, and BotFleet's
          permission guards do not apply.
        </div>
      )}
      {["minimax", "claude", "grok", "codex", "antigravity", "cursorAgent", "deepseekAgent", "dshAgent", "antigravityAgent", "grokAgent", "claudeAgent", "mcodeAgent"].includes(instance.driverKind) && (
        <EngineCallout driverKind={instance.driverKind} instanceId={instance.instanceId} />
      )}
      {instance.driverKind === "boxAgent" && (
        <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-accent/20">
          <strong className="text-ink">Runs on Its Own Computer.</strong>
          {"  "}A bot on the Computer engine runs its turn on box.ascii.dev, not on this computer, so it has no team tools, no peers to ask, no approval cards, no memory, and no skills.
          {"  "}Pick another engine for a bot that has to work with the rest of your team.
        </div>
      )}
      {isCustom && (
        <div className="mt-2 rounded bg-accent/10 px-2 py-1.5 text-[11px] leading-relaxed text-ink-secondary border border-accent/20">
          <strong className="text-ink">{customEngineCalloutTitle(instance.driverKind)}</strong>
          {"  "}Configured models: {instance.models.options.map((o) => o.label || o.id).join(", ") || "default"}.
        </div>
      )}
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
      {open && enabled && (
        <CustomPicker
          instance={instance}
          cliDefault={instance.cliDefault}
          isBusy={isBusy}
          onClose={() => setOpen(false)}
          onSave={(cli) => patchWithLocalError({ cli })}
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete Custom Engine?"
        body={`Delete “${instance.displayName}”?  This cannot be undone.`}
        confirmLabel="Delete Engine"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={confirmDeleteEngine}
      />
    </div>
  );
}

function AddCustomEngineModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => Promise<void> }) {
  const [driver, setDriver] = useState(ADD_ENGINE_DRIVERS[0].driver);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = addEngineDriverOption(driver);

  // Switching engine offers that engine's own endpoint, but only into a
  // field the person has not typed in yet — retyping over somebody's URL
  // because they glanced at the other tab would be worse than no help at all.
  const chooseDriver = (next: string) => {
    setDriver(next);
    setError(null);
    const suggestion = addEngineDriverOption(next).suggestedEndpoint;
    if (suggestion && !endpoint.trim()) setEndpoint(suggestion);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 300 * 1024) {
      setError("Icon file must be under 300 KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setIconUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const save = () => {
    const trimmedName = name.trim();
    const trimmedUrl = endpoint.trim();
    const models = option.requiresModels
      ? modelsText
          .split(/[\n,]+/)
          .map((m) => m.trim())
          .filter(Boolean)
      : [];
    const invalid = validateAddEngine({
      driver,
      name: trimmedName,
      endpoint: trimmedUrl,
      key: apiKey,
      models,
    });
    if (invalid) {
      setError(invalid);
      return;
    }

    setSaving(true);
    setError(null);
    // Every other credential card in this app (ApiKeys.tsx, the Secret Store
    // card) routes through window.ogb.setCredential when the desktop bridge
    // exists, so the key reaches the OS-encrypted store instead of sitting
    // in plaintext config.json. A custom engine's key is a dynamic per-
    // instance secret, not one of that bridge's fixed named slots, so it
    // takes a sibling method (createCustomEngine, above) plus a
    // create-then-set-credential sequence: the instance id is only known
    // once the server has deduped the slug.
    createCustomEngine(buildEngineCredentialDeps(), {
      name: trimmedName,
      endpoint: trimmedUrl,
      driver,
      key: apiKey.trim(),
      models,
      iconUrl: option.supportsIcon ? iconUrl.trim() || undefined : undefined,
    })
      .then(() => Promise.resolve(onAdded()).catch(() => {}))
      .then(onClose)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex max-h-[90vh] w-full max-w-[540px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl text-ink">
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="text-[16px] font-semibold text-ink">Add Engine</div>
            <div className="mt-1 text-[12px] text-ink-secondary">{option.blurb}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 text-[13px]">
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
              Engine Type
            </label>
            <div role="radiogroup" aria-label="Engine Type" className="flex gap-2">
              {ADD_ENGINE_DRIVERS.map((candidate) => (
                <button
                  key={candidate.driver}
                  type="button"
                  role="radio"
                  aria-checked={candidate.driver === driver}
                  onClick={() => chooseDriver(candidate.driver)}
                  className={cn(
                    "flex-1 rounded-xl border px-3.5 py-2 text-[12.5px] font-medium outline-none",
                    candidate.driver === driver
                      ? "border-accent/70 bg-accent/10 text-ink"
                      : "border-hairline/60 bg-inset text-ink-secondary hover:text-ink",
                  )}
                >
                  {candidate.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
              Engine Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={driver === "minimax" ? "e.g. MiniMax China, MiniMax Team Account" : "e.g. Together AI, Ollama Local, Groq Open"}
              className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
              API Endpoint URL
            </label>
            <input
              type="text"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder={option.endpointPlaceholder}
              className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[13px] font-mono text-ink outline-none placeholder:font-sans placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
              API Key{" "}
              <span className="font-normal normal-case text-[11px]">
                {option.requiresKey ? "· this connection's own key" : "· optional"}
              </span>
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                option.requiresKey
                  ? "The MiniMax key this connection bills against"
                  : "Optional API key (leave blank for local Ollama / LM Studio)"
              }
              className="w-full rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[13px] font-mono text-ink outline-none placeholder:font-sans placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
          </div>

          {option.requiresModels ? (
            <div>
              <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
                Model IDs <span className="font-normal normal-case text-[11px]">· 1 to 15 models, comma or newline separated</span>
              </label>
              <textarea
                rows={3}
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder="meta-llama/llama-3.3-70b-instruct&#10;mistralai/mixtral-8x7b-instruct"
                className="w-full resize-y rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-secondary/60 focus:border-accent/70"
              />
            </div>
          ) : (
            <div className="rounded-xl border border-hairline/60 bg-inset px-3.5 py-2.5 text-[12px] text-ink-secondary">
              MiniMax publishes its own model list, so there is nothing to type here.  This connection offers the
              same models as the built-in one and bills them to the key above.
            </div>
          )}

          {option.supportsIcon && (
          <div>
            <label className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary uppercase tracking-wide">
              Engine Icon <span className="font-normal normal-case text-[11px]">· optional SVG or image URL / upload</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={iconUrl.startsWith("data:") ? "[Uploaded image file]" : iconUrl}
                onChange={(e) => setIconUrl(e.target.value)}
                readOnly={iconUrl.startsWith("data:")}
                placeholder="https://.../icon.svg or data:image/..."
                className="flex-1 rounded-xl border border-hairline/60 bg-inset px-3.5 py-2 text-[12.5px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-hairline/60 bg-raised px-3 py-2 text-[12px] font-medium text-ink hover:bg-raised-hover">
                <Upload size={13} />
                Upload
                <input type="file" accept=".svg,.png,.webp,.jpg,.jpeg" className="hidden" onChange={handleFileUpload} />
              </label>
              {iconUrl && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <div className="flex size-8 items-center justify-center rounded-lg border border-hairline/40 bg-raised p-1">
                    <img src={iconUrl} alt="Icon preview" className="size-full object-contain" />
                  </div>
                  <button
                    type="button"
                    onClick={() => setIconUrl("")}
                    className="text-[11px] text-ink-secondary hover:text-danger"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[12px] text-danger">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={
              saving ||
              !name.trim() ||
              !endpoint.trim() ||
              (option.requiresKey && !apiKey.trim()) ||
              (option.requiresModels && !modelsText.trim())
            }
            className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {driver === "minimax" ? "Add MiniMax Connection" : "Add Custom Engine"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EnginesSettings() {
  const { state, dispatch, refreshInstances } = useStore();
  const [busyInstanceId, setBusyInstanceId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handlePatch = useCallback(
    async (
      instanceId: string,
      patch: { cli?: string; fullAuto?: boolean; enabled?: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      setBusyInstanceId(instanceId);
      setGlobalError(null);
      try {
        const res = await api(`/api/instances/${encodeURIComponent(instanceId)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        if (res?.instances) {
          dispatch({ type: "instances", instances: res.instances });
        }
        return { ok: true };
      } catch (e: any) {
        const message = e.message || "Failed to update engine settings";
        setGlobalError(message);
        return { ok: false, error: message };
      } finally {
        setBusyInstanceId(null);
      }
    },
    [dispatch],
  );

  // Include CLI engines, MiniMax, OpenAI-compat, and custom engines
  const rows = state.instances.filter((i) =>
    i.cli !== undefined ||
    i.cliDefault !== undefined ||
    i.driverKind === "minimax" ||
    i.driverKind === "openai-compat" ||
    Boolean(i.isCustom),
  );
  // Engines the user has turned off used to sit behind a "Show (N)" link
  // that defaulted to hidden, so a newly added engine whose CLI is not
  // installed yet was simply absent from Settings — the reader saw a count
  // and no list.  Default to showing them; the toggle stays for anyone who
  // wants the short rail.
  const [showDisabled, setShowDisabled] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div className="text-[12px] leading-relaxed text-ink-secondary flex-1">
          <strong className="text-ink">Set CLI…</strong> points an engine at a specific binary,{"  "}
          <strong className="text-ink">Reset</strong> goes back to the driver&apos;s default,{"  "}
          <strong className="text-ink">Bypass permissions</strong> drops the approval cards and hands the engine full tool autonomy.{"  "}
          Saving any of them reloads providers and interrupts running turns.
        </div>
        <button
          type="button"
          onClick={() => setAddModalOpen(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3.5 py-2 text-[12.5px] font-medium text-ink hover:bg-raised-hover shadow-sm"
        >
          <Plus size={14} />
          Add Engine
        </button>
      </div>
      {busyInstanceId && (
        <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] text-accent">
          <Loader2 size={13} className="animate-spin shrink-0" />
          <span>Updating engine settings…</span>
        </div>
      )}
      {globalError && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <TriangleAlert size={13} className="shrink-0" />
          <span>{globalError}</span>
        </div>
      )}
      {rows.length === 0 && (
        <div className="text-[13px] text-ink-secondary">No engines detected yet.</div>
      )}
      <EngineCapabilitiesMatrix instances={rows} />
      {(() => {
        const enabled = rows.filter(isEngineEnabled);
        const disabled = rows.filter((row) => !isEngineEnabled(row));
        const { subscription, custom } = splitEngineRail(enabled);
        subscription.sort((a, b) => (a.snapshot.state === "unavailable" ? 1 : 0) - (b.snapshot.state === "unavailable" ? 1 : 0));
        return (
          <>
            {subscription.length > 0 && <EngineGroupLabel>Cloud</EngineGroupLabel>}
            {subscription.map((i) => (
              <EngineRow
                key={i.instanceId}
                instance={i}
                busyInstanceId={busyInstanceId}
                onPatch={(patch) => handlePatch(i.instanceId, patch)}
              />
            ))}
            {custom.length > 0 && <EngineGroupLabel className="pt-1">Local & Custom</EngineGroupLabel>}
            {custom.map((i) => (
              <EngineRow
                key={i.instanceId}
                instance={i}
                busyInstanceId={busyInstanceId}
                onPatch={(patch) => handlePatch(i.instanceId, patch)}
              />
            ))}
            {disabled.length > 0 && (
              <>
                <div className="mt-2 flex items-center gap-2">
                  <EngineGroupLabel>Not Enabled</EngineGroupLabel>
                  <button
                    type="button"
                    onClick={() => setShowDisabled((value) => !value)}
                    aria-expanded={showDisabled}
                    className="text-[11px] text-ink-secondary hover:text-ink"
                  >
                    {showDisabled ? "Hide" : `Show (${disabled.length})`}
                  </button>
                </div>
                {showDisabled && (
                  <div className="flex flex-col gap-3">
                    {disabled.map((i) => (
                      <EngineRow
                        key={i.instanceId}
                        instance={i}
                        busyInstanceId={busyInstanceId}
                        reason={engineUnavailableReason(i)}
                        onPatch={(patch) => handlePatch(i.instanceId, patch)}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        );
      })()}

      {addModalOpen && (
        <AddCustomEngineModal
          onClose={() => setAddModalOpen(false)}
          onAdded={() => refreshInstances({ fresh: true })}
        />
      )}
    </div>
  );
}
