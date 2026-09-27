import path from "node:path";
import { resolveSavablePath } from "./save-file.mjs";

const OUTSIDE_MESSAGE = "Only files created by your bots can be opened";
const INERT_EXTENSIONS = new Set([
  ".txt", ".md", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".csv", ".json", ".xml", ".yaml", ".yml", ".docx", ".xlsx", ".pptx",
]);

// Untrusted bot-written links may point to a script or executable. Those may
// be revealed in the file manager but must never reach the OS default opener.
export function mayOpenBotFile(filePath) {
  return INERT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function resolveOpenablePath(rawPath, options = {}) {
  return resolveSavablePath(rawPath, { ...options, outsideMessage: OUTSIDE_MESSAGE });
}
