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

// The shell operators, other than `&&`, that end one command and start the
// next: `||`, `;`, `|`, a newline and a lone `&`.  Each lets a later command's
// status stand in for an earlier failure, or runs the two apart.  A `&` that
// belongs to a redirection (`2>&1`, `>&2`, `<&3`, `&>log`) is not one of them.
const OPERATOR = /\|\||[|;\n\r]|(?<![<>])&(?!>)/;
const STEP_BREAK = new RegExp(`&&|${OPERATOR.source}`);

// A redirection (`2>&1`, `>&2`, `&>log`, `>log`, `2>/dev/null`, `<in`) changes
// where a command's streams go and never its exit status, so a chained step
// that carries one is still that step.  A target written after a space
// (`2> log`) is left in place, and that step then reads as not its own.
const REDIRECTION = /(?:\d*|&)(?:>>?|<)(?:&\d+-?|[^\s&|;<>]*)/g;

/**
 * What keeps `suites` from running under `pnpm test` through `script`.
 * The script must be exactly `node --test` followed by literal test files:
 * a flag can filter cases out, a shell operator can mask a failure, and a
 * glob can pick up files nobody named.  A newline ends a command, so a file
 * on a later line would be run as a command of its own, not as a test file.
 */
export function gateWiringProblems(scripts, script, suites) {
  if (!Object.hasOwn(scripts, script)) return [`package.json has no ${script} script`];
  const problems = [];
  if (/[\n\r]/.test(scripts[script])) {
    problems.push(`${script} carries a newline, which ends the command, so a file after it is not run by \`node --test\``);
  }
  const [runner, mode, ...files] = scripts[script].trim().split(/\s+/);
  if (runner !== "node" || mode !== "--test") problems.push(`${script} does not start with \`node --test\``);
  for (const file of files) {
    if (!TEST_FILE.test(file)) problems.push(`${script} carries \`${file}\`, which is not a literal test file path`);
  }
  for (const suite of suites) {
    if (!files.includes(suite)) problems.push(`${script} does not name ${suite}, so hosted CI never runs it`);
  }
  const testCommand = String(scripts.test ?? "");
  const chain = testCommand.split("&&").map((step) => step.replace(REDIRECTION, " ").trim().replace(/\s+/g, " "));
  if (!chain.includes(`pnpm ${script}`)) {
    problems.push(`\`pnpm test\` does not chain \`pnpm ${script}\` as its own step, so hosted CI never runs it`);
  }
  // A clean step inside a chain that something else masks still cannot fail
  // CI: `a && b || true` exits 0 whatever b does, and `a && b | tee log`,
  // `a && b ; c` or a newline before `c` report only the last command.  Only
  // `&&` may join steps; a redirection such as `2>&1` joins nothing.
  const masking = testCommand.replaceAll("&&", " ").match(OPERATOR);
  if (masking) {
    const shown = /\s/.test(masking[0]) ? "a newline" : `\`${masking[0]}\``;
    problems.push(`\`pnpm test\` carries ${shown}, so a failing step in its chain would not fail hosted CI`);
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

// The environment assignments a step sets for its command: the leading
// `NAME=value` tokens, after an optional `env` or `cross-env`.  A `NAME=value`
// after the runner is an argument to node and leaves the variable unset.  This
// reads one command of one pipeline stage; an `env` option, or an `export` in
// an earlier step, is not followed, so such a step reads as not wired.
function leadingAssignments(tokens) {
  let index = tokens[0] === "env" || tokens[0] === "cross-env" ? 1 : 0;
  const assigned = [];
  while (index < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[index])) assigned.push(tokens[index++]);
  return { assigned, command: tokens[index] };
}

/**
 * Scripts that would run the opt-in test `file` without its switch.  Such a
 * run reports one skip, which reads as coverage that never ran.  A step
 * reaches the file by naming it anywhere (any prefix, or run directly), or by
 * a glob that covers it in a `--test` or `node` run; the switch must be set in that step's own
 * environment, as a leading `NAME=value` assignment before the runner.  A step
 * ends at `&&`, `||`, `;`, `|`, a newline or a lone `&`, because each stage of
 * a pipeline has its own environment and an assignment binds to the command
 * right after it, not to a later stage.
 */
export function optInProblems(scripts, file, optIn) {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const problems = [];
  for (const [name, command] of Object.entries(scripts)) {
    for (const step of command.split(STEP_BREAK)) {
      const tokens = step.trim().split(/\s+/);
      const { assigned, command: runner } = leadingAssignments(tokens);
      const named = tokens.some((token) => token.includes(base));
      // A glob reaches the file when node runs it: `node --test <glob>`, or
      // `node <glob>`, where the shell expands the glob and node runs what it
      // matched.  The same glob given to another tool (oxlint) runs nothing.
      const globbed = (tokens.includes("--test") || runner === "node") && tokens.some((token) => globCovers(token, file));
      if ((named || globbed) && !assigned.includes(optIn)) {
        problems.push(`${name} reaches ${file} without ${optIn}, so it would only report a skip`);
      }
    }
  }
  return problems;
}
