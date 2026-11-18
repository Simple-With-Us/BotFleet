// Why a node:test file runs in hosted CI: the workflow runs `pnpm test`
// (pinned by scripts/ci-change-scope.node-test.mjs), `pnpm test` chains named
// scripts with `&&`, and each of those is one `node --test <files>` run.
// vitest does not collect *.node-test.mjs, so a file no script names never
// runs, and nothing reports that it did not.
//
// These checks read package.json's `scripts` and answer in sentences.  An
// empty list means wired.  They compare whole tokens and whole steps: a
// renamed path, a flag or a masked failure must read as "not wired", never as
// a near miss that still passes.

const TEST_FILE = /^[\w./-]+\.node-test\.mjs$/;
const GLOB = /[*?[\]{}]/;

/**
 * What keeps `suites` from running under `pnpm test` through `script`.
 * The script must be exactly `node --test` followed by literal test files:
 * a flag can filter cases out, a shell operator can mask a failure, and a
 * glob can pick up files nobody named.
 */
export function gateWiringProblems(scripts, script, suites) {
  if (!Object.hasOwn(scripts, script)) return [`package.json has no ${script} script`];
  const problems = [];
  const [runner, mode, ...files] = scripts[script].trim().split(/\s+/);
  if (runner !== "node" || mode !== "--test") problems.push(`${script} does not start with \`node --test\``);
  for (const file of files) {
    if (!TEST_FILE.test(file)) problems.push(`${script} carries \`${file}\`, which is not a literal test file path`);
  }
  for (const suite of suites) {
    if (!files.includes(suite)) problems.push(`${script} does not name ${suite}, so hosted CI never runs it`);
  }
  const chain = String(scripts.test ?? "").split("&&").map((step) => step.trim());
  if (!chain.includes(`pnpm ${script}`)) {
    problems.push(`\`pnpm test\` does not chain \`pnpm ${script}\` as its own step, so hosted CI never runs it`);
  }
  return problems;
}

// Errs toward "covers": the literal text before the first wildcard and after
// the last one must both fit the file.  A pattern this calls covering may not
// match in a real shell, which costs a rename; the other error would let an
// opt-in file into a default run.
function globCovers(token, file) {
  const pattern = token.replace(/["']/g, "").replace(/^\.\//, "");
  const first = pattern.search(GLOB);
  if (first === -1) return false;
  let last = pattern.length - 1;
  while (!GLOB.test(pattern[last])) last -= 1;
  return file.startsWith(pattern.slice(0, first)) && file.endsWith(pattern.slice(last + 1));
}

/**
 * Scripts that would run the opt-in test `file` without its switch.  Such a
 * run reports one skip, which reads as coverage that never ran.  A step
 * reaches the file by naming it anywhere (any prefix, or run directly), or by
 * a `--test` glob that covers it; the switch must be a token of that step.
 */
export function optInProblems(scripts, file, optIn) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const problems = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const step of command.split(/&&|\|\||;/)) {
      const tokens = step.trim().split(/\s+/);
      const named = tokens.some((token) => token.includes(base));
      const globbed = tokens.includes("--test") && tokens.some((token) => globCovers(token, file));
      if ((named || globbed) && !tokens.includes(optIn)) {
        problems.push(`${name} reaches ${file} without ${optIn}, so it would only report a skip`);
      }
    }
  }
  return problems;
}
