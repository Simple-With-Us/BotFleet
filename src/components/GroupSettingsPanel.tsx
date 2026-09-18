import { useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Folder,
  FolderPlus,
  ImagePlus,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { useStore, getRoomTerminology, type Group, type GroupDefaultResponder } from "@/state/store";
import { effectiveDefaultResponder } from "@/lib/group-routing";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { MausAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import { railAsideClass } from "@/lib/layout-rails";

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[12.5px] font-medium text-ink">{label}</label>
      {description && <p className="text-[11.5px] leading-relaxed text-ink-secondary">{description}</p>}
      {children}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[13.5px] text-ink placeholder:text-ink-secondary/50 focus:border-accent focus:outline-none";

export function GroupSettingsPanel({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const terminology = getRoomTerminology(state.config);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newExtraCwd, setNewExtraCwd] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);
  const [editingPrimaryCwd, setEditingPrimaryCwd] = useState(false);
  const [primaryCwdDraft, setPrimaryCwdDraft] = useState(group.cwd || "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const members = state.bots.filter((b) => group.memberIds.includes(b.id));
  const crop = group.avatarCrop ?? "rounded";
  const responder = effectiveDefaultResponder(group, members);
  const responderValue = responder.kind === "member" ? `member:${responder.botId}` : responder.kind;

  const changeResponder = (nextValue: string) => {
    let next: GroupDefaultResponder;
    if (nextValue === "everyone") next = { kind: "everyone" };
    else if (nextValue === "mentions") next = { kind: "mentions" };
    else next = { kind: "member", botId: nextValue.slice("member:".length) };
    patch({ defaultResponder: next });
  };

  const patch = (patchData: Partial<Group>) => {
    dispatch({
      type: "patchGroup",
      groupId: group.id,
      patch: patchData,
    });
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, WebP, or HEIC image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      patch({ avatarUrl, avatarCrop: crop });
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAvatar = () => {
    setError(null);
    patch({ avatarUrl: null, avatarCrop: "circle" });
  };

  const toggleMember = (botId: string) => {
    const known = new Set(state.bots.map((bot) => bot.id));
    const live = group.memberIds.filter((id) => known.has(id));
    const isMember = live.includes(botId);
    let updated: string[];
    if (isMember) {
      if (live.length <= 1) {
        setError("A channel must have at least one bot member.");
        return;
      }
      updated = live.filter((id) => id !== botId);
    } else {
      updated = [...live, botId];
    }
    patch({ memberIds: updated });
  };

  const handleAddExtraCwd = () => {
    const trimmed = newExtraCwd.trim();
    if (!trimmed) return;
    const current = group.extraCwds ?? [];
    if (!current.includes(trimmed)) {
      patch({ extraCwds: [...current, trimmed] });
    }
    setNewExtraCwd("");
    setAddingFolder(false);
  };

  const handleRemoveExtraCwd = (pathToRemove: string) => {
    const current = group.extraCwds ?? [];
    patch({ extraCwds: current.filter((p) => p !== pathToRemove) });
  };

  const handleDeleteGroup = () => {
    dispatch({ type: "deleteGroup", groupId: group.id });
    dispatch({ type: "toggleSettings", open: false });
  };

  return (
    <aside className={railAsideClass("w-[420px]", "shadow-2xl")}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-hairline/30 px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={`Collapse ${terminology.singular.toLowerCase()} settings`}
          title={`Collapse ${terminology.singular.toLowerCase()} settings`}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{terminology.singular} Settings</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={`Close ${terminology.singular.toLowerCase()} settings`}
          title={`Close ${terminology.singular.toLowerCase()} settings`}
          className="flex size-9 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-5">
          {/* Avatar Card */}
          <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card p-4">
            <div className="text-[12.5px] font-medium text-ink">{terminology.singular} Avatar</div>
            <div className="my-4 flex justify-center">
              {group.avatarUrl ? (
                <img
                  src={group.avatarUrl}
                  alt={group.name}
                  className="size-24 object-cover shadow-md ring-1 ring-hairline"
                  style={{
                    borderRadius:
                      crop === "square" ? "0" : crop === "rounded" ? "22%" : "50%",
                  }}
                />
              ) : (
                <div className="flex size-24 items-center justify-center -space-x-3 rounded-full bg-control p-2 shadow-inner">
                  {members.slice(0, 3).map((b) => (
                    <MausAvatar
                      key={b.id}
                      color={b.color}
                      state="happy"
                      size={36}
                      motion="none"
                      motionKey={0}
                      animated={false}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,image/avif"
                className="sr-only"
                onChange={(e) => void uploadAvatar(e.target.files?.[0])}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
                Upload Image
              </button>
              {group.avatarUrl && (
                <button
                  type="button"
                  onClick={removeAvatar}
                  disabled={uploading}
                  aria-label={`Remove ${terminology.singular.toLowerCase()} avatar image`}
                  title="Remove Image"
                  className="flex size-9 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>

            {/* Shape selection */}
            {group.avatarUrl && (
              <div className="mt-3 border-t border-hairline/40 pt-3">
                <div className="mb-2 text-[11.5px] font-medium uppercase tracking-wider text-ink-secondary">
                  Shape
                </div>
                <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
                  {(["circle", "rounded", "square"] as const).map((shape, idx) => (
                    <button
                      key={shape}
                      type="button"
                      onClick={() => patch({ avatarCrop: shape })}
                      className={cn(
                        "py-1.5 text-[12.5px] font-medium capitalize transition-colors",
                        idx > 0 && "border-l border-hairline/40",
                        crop === shape ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
                      )}
                    >
                      {shape}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>

          {/* Group / Channel Name */}
          <Field label={`${terminology.singular} Name`}>
            <input
              type="text"
              value={group.name}
              onChange={(e) => patch({ name: e.target.value })}
              className={inputCls}
              placeholder="e.g. Operations, Core Dev, Triage"
            />
          </Field>

          {/* Default Responder Mode */}
          <Field
            label="Default Responder"
            description={`Controls which bot responds when a message in this ${terminology.singular.toLowerCase()} has no explicit @mention.`}
          >
            <select
              value={responderValue}
              onChange={(e) => changeResponder(e.target.value)}
              className={inputCls}
            >
              <optgroup label={`${terminology.singular} lead`}>
                {members.map((member) => (
                  <option key={member.id} value={`member:${member.id}`}>
                    Lead: {member.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Behavior">
                <option value="everyone">Everyone responds</option>
                <option value="mentions">Only when mentioned</option>
              </optgroup>
            </select>
          </Field>

          {/* Section Heading */}
          <Field label="Sidebar Section" description={`Optional section heading to group this ${terminology.singular.toLowerCase()} in the sidebar.`}>
            <input
              type="text"
              value={group.section || ""}
              onChange={(e) => patch({ section: e.target.value || undefined })}
              className={inputCls}
              placeholder="e.g. Products, Fleet, Operations"
            />
          </Field>

          {/* System Instructions / Bulletin */}
          <Field
            label={`${terminology.singular} Instructions`}
            description={`System instructions injected into every member bot's turn in this ${terminology.singular.toLowerCase()}.`}
          >
            <textarea
              rows={4}
              value={group.bulletin}
              onChange={(e) => patch({ bulletin: e.target.value })}
              className={cn(inputCls, "resize-y font-mono text-[12.5px]")}
              placeholder="e.g. Always write production-ready TypeScript; check tests before responding; coordinate with peer bots."
            />
          </Field>

          {/* Associated Repositories */}
          <div className="flex flex-col gap-2 rounded-xl border border-hairline/40 bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-ink">Associated Repositories</span>
              <button
                type="button"
                onClick={() => setAddingFolder(true)}
                className="flex items-center gap-1 text-[12px] text-accent hover:underline"
              >
                <Plus size={13} /> Add Repo
              </button>
            </div>
            <p className="text-[11.5px] text-ink-secondary">
              Attached codebases provide full context and tool access to all bots in this {terminology.singular.toLowerCase()}.
            </p>

            <div className="mt-1 flex flex-col gap-2">
              {/* Primary CWD */}
              <div className="flex flex-col gap-1.5 rounded-lg border border-hairline/40 bg-inset p-3">
                <div className="flex items-center justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <Folder size={15} className="shrink-0 text-accent" />
                    <span className="text-[12px] font-medium text-ink">Primary Working Directory</span>
                  </div>
                  {!editingPrimaryCwd && (
                    <button
                      type="button"
                      onClick={() => {
                        setPrimaryCwdDraft(group.cwd || "");
                        setEditingPrimaryCwd(true);
                      }}
                      className="text-[11.5px] text-accent hover:underline"
                    >
                      {group.cwd ? "Edit" : "Set Path"}
                    </button>
                  )}
                </div>
                {editingPrimaryCwd ? (
                  <div className="mt-1 flex flex-col gap-2">
                    <input
                      type="text"
                      value={primaryCwdDraft}
                      onChange={(e) => setPrimaryCwdDraft(e.target.value)}
                      placeholder="/Users/username/Code/project-root"
                      className={cn(inputCls, "text-[12px] font-mono")}
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          patch({ cwd: primaryCwdDraft.trim() || undefined });
                          setEditingPrimaryCwd(false);
                        }
                        if (e.key === "Escape") setEditingPrimaryCwd(false);
                      }}
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingPrimaryCwd(false)}
                        className="rounded px-2 py-1 text-[11.5px] text-ink-secondary hover:bg-control"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          patch({ cwd: primaryCwdDraft.trim() || undefined });
                          setEditingPrimaryCwd(false);
                        }}
                        className="rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="truncate text-[12px] font-mono text-ink-secondary" title={group.cwd || "Default workspace (no path set)"}>
                    {group.cwd || "Default workspace (no path set)"}
                  </div>
                )}
              </div>

              {/* Extra CWDs */}
              {(group.extraCwds ?? []).map((path) => (
                <div
                  key={path}
                  className="flex items-center justify-between rounded-lg border border-hairline/40 bg-inset px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderPlus size={15} className="shrink-0 text-ink-secondary" />
                    <span className="truncate text-[12.5px] font-mono text-ink" title={path}>{path}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveExtraCwd(path)}
                    className="p-1 text-ink-secondary hover:text-danger"
                    title="Remove Auxiliary Repository"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}

              {addingFolder && (
                <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-accent/40 bg-inset p-2.5">
                  <input
                    type="text"
                    value={newExtraCwd}
                    onChange={(e) => setNewExtraCwd(e.target.value)}
                    placeholder="/Users/username/Code/another-repo"
                    className={cn(inputCls, "text-[12.5px] font-mono")}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddExtraCwd();
                      if (e.key === "Escape") setAddingFolder(false);
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setAddingFolder(false)}
                      className="rounded px-2 py-1 text-[12px] text-ink-secondary hover:bg-control"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleAddExtraCwd}
                      className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"
                    >
                      Add Path
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Member Bots Roster */}
          <div className="flex flex-col gap-2 rounded-xl border border-hairline/40 bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-ink">Member Bots</span>
              <span className="text-[11.5px] text-ink-secondary">{members.length} active</span>
            </div>
            <p className="text-[11.5px] text-ink-secondary">Select which bots participate in this {terminology.singular.toLowerCase()}.</p>

            <div className="mt-1.5 flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {state.bots.map((bot) => {
                const isSelected = group.memberIds.includes(bot.id);
                return (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => toggleMember(bot.id)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-accent/40 bg-accent/10 text-ink"
                        : "border-hairline/40 bg-inset text-ink-secondary hover:bg-control/50",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <MausAvatar color={bot.color} state="happy" size={24} animated={false} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink" title={bot.name}>{bot.name}</div>
                        {bot.title && <div className="truncate text-[11px] text-ink-secondary" title={bot.title}>{bot.title}</div>}
                      </div>
                    </div>
                    <div
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-md border text-[11px]",
                        isSelected ? "border-accent bg-accent text-white" : "border-hairline bg-control",
                      )}
                    >
                      {isSelected && <Check size={12} />}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Danger Zone */}
          <div className="mt-2 flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger/5 p-4">
            <div className="flex items-center gap-1.5 text-[13px] font-medium text-danger">
              <AlertTriangle size={15} /> Delete Channel
            </div>
            <p className="text-[11.5px] text-ink-secondary">
              Deleting this channel removes its transcript and task history. Bot definitions are preserved.
            </p>
            {confirmDelete ? (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="flex-1 rounded-lg border border-hairline bg-control py-2 text-[12.5px] text-ink hover:bg-raised-hover"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteGroup}
                  className="flex-1 rounded-lg bg-danger py-2 text-[12.5px] font-medium text-white hover:opacity-90"
                >
                  Confirm Delete
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="mt-1 rounded-lg border border-danger/40 bg-control py-2 text-[12.5px] font-medium text-danger hover:bg-danger/10"
              >
                Delete {group.name}
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
