import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Open the packaged or running BotFleet app on this Mac so a phone can
 * bring the desktop to the front.  Other platforms are a no-op. */
export async function openBotFleetDesktop(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== "darwin") {
    return { ok: false, error: "opening the desktop app is a Mac action" };
  }
  try {
    await execFileAsync("open", ["-a", "BotFleet"], { timeout: 8000 });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.slice(0, 300) };
  }
}
