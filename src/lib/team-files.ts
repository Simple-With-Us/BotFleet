import { api } from "@/state/store";

interface ExportedPlaybook {
  name: string;
  members: number;
  markdown: string;
}

function downloadPlaybook(playbook: ExportedPlaybook): { name: string; members: number } {
  const slug =
    playbook.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "botmrr-team";
  const blob = new Blob([playbook.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${slug}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { name: playbook.name, members: playbook.members };
}

/** Export every active sidebar bot as one portable Chief-of-Staff Markdown. */
export async function downloadAllBots(): Promise<{ name: string; members: number }> {
  const playbook = (await api("/api/teams/export", {
    method: "POST",
    body: JSON.stringify({ format: "package" }),
  })) as ExportedPlaybook;
  return downloadPlaybook(playbook);
}

interface ExportedTranscripts {
  exportedAt: string;
  botCount: number;
  channelCount: number;
  conversationCount: number;
  conversations: unknown[];
}

/** Save every conversation on this computer as one JSON file.
 *
 * Export only.  A transcript is tied to thread ids, message parents and
 * provider sessions belonging to the machine that made it, so importing one
 * elsewhere would produce a conversation no bot could continue. */
export async function downloadAllConversations(): Promise<{ conversations: number }> {
  const dump = (await api("/api/transcripts/export")) as ExportedTranscripts;
  const stamp = dump.exportedAt.slice(0, 10);
  const blob = new Blob([JSON.stringify(dump, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `botfleet-conversations-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { conversations: dump.conversationCount };
}
