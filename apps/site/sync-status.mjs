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

const checkOnly = process.argv.includes("--check");
const path = new URL("./features.json", import.meta.url);
const data = JSON.parse(readFileSync(path, "utf8"));

const prs = JSON.parse(
  execFileSync("gh", ["api", "repos/Simple-With-Us/BotFleet/pulls?state=all&per_page=100"], { encoding: "utf8" })
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
