import { readFile } from "node:fs/promises";

/** Normalize shell script text to LF newlines so indexOf and `\n` literals match on every checkout (including Windows autocrlf). */
export function normalizeShellSource(text) {
  return text.replace(/\r\n/g, "\n");
}

export async function readShellSource(path) {
  return normalizeShellSource(await readFile(path, "utf8"));
}
