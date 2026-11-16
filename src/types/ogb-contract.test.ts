// The preload's contract, stated once.
//
// `electron/preload.cjs` is what the renderer really gets; `src/types/ogb.d.ts`
// is what the renderer believes it gets.  When those two drift, the renderer
// compiles against a shape the bridge does not have (or the other way round),
// and the cast that hides the drift is what a reader trusts.  This test reads
// both files and compares the member lists, so a member added to one side and
// not the other fails here instead of at runtime.
//
// The companion sidecar is the member this file exists for: it was the one
// the preload exposed and the shared type did not, which left two components
// each carrying their own copy of the contract.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const preloadPath = join(repoRoot, "electron", "preload.cjs");
const typesPath = join(repoRoot, "src", "types", "ogb.d.ts");

/** The member names of the object literal that starts at `marker`, read from
 *  the source text.  The braces are counted so a nested object does not end
 *  the block early. */
function membersOf(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`${marker} is not in the file`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    const char = source[end];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(open + 1, end);
  // A member is `name:` at the start of a line, with the members of a nested
  // object indented further than the ones beside it.
  const names = new Set<string>();
  let indent = Number.POSITIVE_INFINITY;
  for (const line of body.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[?]?\s*[:(]/.exec(line);
    if (!match) continue;
    const depthOfLine = line.length - line.trimStart().length;
    if (depthOfLine > indent) continue;
    indent = Math.min(indent, depthOfLine);
    names.add(match[1]!);
  }
  return [...names].sort();
}

describe("the preload bridge and the shared type agree", () => {
  const preload = readFileSync(preloadPath, "utf8");
  const types = readFileSync(typesPath, "utf8");

  it("declares the companion sidecar in the shared type", () => {
    expect(membersOf(types, "companion?: {")).toEqual(
      expect.arrayContaining(["state", "start", "stop", "tryCloudflare", "keepAwake", "pairing", "cloudDesktop", "revoke"]),
    );
  });

  it("gives the companion the same members the preload exposes", () => {
    expect(membersOf(types, "companion?: {")).toEqual(membersOf(preload, "companion: {"));
  });

  it("keeps the companion account bridge in step too", () => {
    expect(membersOf(types, "companionAccount?: {")).toEqual(membersOf(preload, "companionAccount: {"));
  });
});
