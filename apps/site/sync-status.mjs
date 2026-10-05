#!/usr/bin/env node
// Semi-automated feature-status sync.  Refreshes each feature's PR state
// (open/merged/closed) in features.json from the GitHub API, and reports
// merged PRs in Simple-With-Us/BotFleet that no feature card cites yet —
// candidates for a new card.  Every BotFleet add-on stays in testing.
// It never moves a feature between sections; that stays a human/agent judgment call.
//
// Usage: node sync-status.mjs          (uses `gh api`, needs gh auth)
//        node sync-status.mjs --check  (report only, do not rewrite json)
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { z } from "zod";

const checkOnly = process.argv.includes("--check");
const path = new URL("./features.json", import.meta.url);

// Both of these cross a trust boundary: one is an external API response and
// the other is a file this script then rewrites.  A shape change or an error
// body that happens to parse would otherwise map `undefined` states straight
// into features.json and be committed as fact.
//
// The response is projected down with `--jq` before it ever reaches this
// process.  That is not only cheaper — a full 100-PR page carries every PR
// body and blew execFileSync's 1 MiB default maxBuffer, so this script was
// failing outright on the current repo size — it also means a body that
// violates the schema cannot leak the rest of the payload into an error
// message.  maxBuffer is raised anyway, as defence in depth.
// A jq ARRAY, not a bare `.[]` — jq emits one value per line otherwise, which
// is not the JSON document this parses.
const PR_FIELDS = "[.[] | {number, title, state, merged_at}]";
const prSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  merged_at: z.string().nullable(),
});
const featuresSchema = z.object({
  sections: z.array(
    z.object({
      features: z.array(
        z.object({
          title: z.string(),
          prov: z.object({
            type: z.string(),
            prs: z.array(z.number().int()).optional(),
            state: z.string().optional(),
            note: z.string().optional(),
          }),
        }),
      ),
    }),
  ),
});

/** Parse, but report only the paths — a ZodError carries the whole input. */
function parseOrExplain(label, schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const where = result.error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${label} did not match the expected shape — ${where}`);
}

const data = parseOrExplain("features.json", featuresSchema, JSON.parse(readFileSync(path, "utf8")));
const prs = parseOrExplain(
  "the GitHub pulls response",
  z.array(prSchema),
  JSON.parse(
    execFileSync("gh", ["api", "repos/Simple-With-Us/BotFleet/pulls?state=all&per_page=100", "--jq", PR_FIELDS], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ),
);
const stateOf = new Map(prs.map((p) => [p.number, p.merged_at ? "merged" : p.state]));

let changed = 0;
const cited = new Set();
for (const s of data.sections) {
  for (const f of s.features) {
    if (f.prov.type !== "pr") continue;
    for (const n of f.prov.prs) cited.add(n);
    const live = stateOf.get(f.prov.prs[0]);
    if (live && live !== f.prov.state) {
      console.log(`state change: "${f.title.replace(/&amp;/g, "&")}" PR #${f.prov.prs[0]} ${f.prov.state} -> ${live}`);
      f.prov.state = live;
      changed++;
    }
  }
}

const unlisted = prs.filter((p) => p.merged_at && !cited.has(p.number));
for (const p of unlisted) console.log(`unlisted merged PR: #${p.number} ${p.title}`);

const unnoted = data.sections
  .flatMap((s) => s.features)
  .filter((f) => f.prov.type === "pr" && f.prov.state === "merged" && !f.prov.note);
for (const f of unnoted) console.log(`merged card with no note: ${f.title.replace(/&amp;/g, "&")}`);

if (changed && !checkOnly) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote features.json (${changed} state change${changed === 1 ? "" : "s"}) — run: node build.mjs`);
} else {
  console.log(changed ? "(check mode: json untouched)" : "no state changes");
}
