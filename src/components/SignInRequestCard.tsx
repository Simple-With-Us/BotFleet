import { useState } from "react";
import { Check, LogIn, Monitor, X } from "lucide-react";

import type { SignInRequestCardData } from "../../shared/sign-in-request.ts";
import { PersistentActionErrorCard } from "@/components/PersistentActionErrorCard";
import { api, useStore, type Message } from "@/state/store";

const GAP = "\u00A0 ";

export function SignInRequestCardView({
  card,
  busy,
  error,
  onOpen,
  onDone,
  onCancel,
  onDismissError,
}: {
  card: SignInRequestCardData;
  busy: "open" | "done" | "cancel" | null;
  error: string | null;
  onOpen: () => void;
  onDone: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}) {
  const open = card.status === "open";
  const statusLine =
    card.status === "done"
      ? `Signed in on this bot's computer.${GAP}The bot will check the screen.`
      : card.status === "cancelled"
        ? "You declined this sign-in."
        : card.status === "replaced"
          ? "A newer sign-in request replaced this one."
          : `Sign in on this bot's computer.${GAP}BotFleet never sees the password.`;

  return (
    <div data-testid="sign-in-card" className="my-2 max-w-md rounded-xl border border-line bg-surface px-3 py-3 text-[13px] text-ink">
      <div className="flex items-start gap-2">
        <LogIn size={16} className="mt-0.5 shrink-0 text-ink-secondary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">Sign in needed</p>
          <p className="mt-1 break-words text-ink-secondary">
            {card.site}
            {card.reason ? `${GAP}${card.reason}` : ""}
          </p>
          <p className="mt-2 leading-relaxed">{statusLine}</p>
        </div>
      </div>
      {error ? (
        <div className="mt-2">
          <PersistentActionErrorCard message={error} onDismiss={onDismissError} />
        </div>
      ) : null}
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-60"
            disabled={busy !== null}
            onClick={onOpen}
          >
            <Monitor size={13} aria-hidden />
            {busy === "open" ? "Opening" : "Open"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-60"
            disabled={busy !== null}
            onClick={onDone}
          >
            <Check size={13} aria-hidden />
            {busy === "done" ? "Sending" : "Done"}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-ink-secondary disabled:opacity-60"
            disabled={busy !== null}
            onClick={onCancel}
          >
            <X size={13} aria-hidden />
            {busy === "cancel" ? "Sending" : "Cancel"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SignInRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const card = message.signIn;
  const [busy, setBusy] = useState<"open" | "done" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!card) return null;
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/sign-in-cards/${encodeURIComponent(message.id)}`;

  const fail = (err: Error) => {
    setError(err.message || "That sign-in action failed.");
  };

  const openComputer = async () => {
    setBusy("open");
    setError(null);
    dispatch({ type: "toggleComputer", open: true });
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/computer/control`, {
        method: "POST",
        body: JSON.stringify({ action: "take" }),
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error("That sign-in action failed."));
    } finally {
      setBusy(null);
    }
  };

  const settle = async (action: "done" | "cancel") => {
    setBusy(action);
    setError(null);
    try {
      await api(`${endpoint}/${action}`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (err) {
      fail(err instanceof Error ? err : new Error("That sign-in action failed."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SignInRequestCardView
      card={card}
      busy={busy}
      error={error}
      onOpen={() => void openComputer()}
      onDone={() => void settle("done")}
      onCancel={() => void settle("cancel")}
      onDismissError={() => setError(null)}
    />
  );
}
