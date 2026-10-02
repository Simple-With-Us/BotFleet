// Command rows for the approval guard in server/auto-approve.ts.
//
// Auto mode approves a shell command that is a single stage with no shell
// metacharacter, which is most of what a developer types, and that is the
// right default.  These rows name the single-stage commands that are not
// ordinary: they wipe a working tree, kill processes, change what launches at
// login, or install software outside the project.  Each one stops for a person
// even in auto mode, even when the program was "always allowed" (`Bash:git`
// must not cover `git clean`).
//
// The rows look at the COMMAND, not at the text.  A regex over the whole
// summary cannot tell `git clean -fd` from `git log --grep="git clean"`, and
// it misses `git -C dir clean`, `"git" clean`, `FOO=1 git clean`,
// `sudo git clean` and `sh -c 'git clean'`.  So the command is split into
// stages, each stage is unquoted into words, env assignments and wrapper
// programs are peeled off, shell `-c` strings are unwrapped, and the rules see
// the program and its arguments.  Words that are only arguments (a grep
// pattern, a commit message) never reach a rule.
//
// Like the rest of the guard this is a "you probably did not mean to hand this
// over unattended" backstop, not a security boundary: a program run through a
// variable (`$TOOL clean`) or a script file is out of its sight.  It stays
// import-free so the tests, and the server, can load it anywhere.

export interface CommandRisk {
  /** `destructive` loses work or processes; `system` changes the computer
   * outside the project (launch agents, cron, global installs). */
  kind: "destructive" | "system";
  /** A stable id for the decision log. */
  rule: string;
}

const destructive = (rule: string): CommandRisk => ({ kind: "destructive", rule });
const system = (rule: string): CommandRisk => ({ kind: "system", rule });

/** Nested `sh -c` strings are unwrapped this deep.  A person does not type
 * more; past it the command is carded instead of guessed at. */
const MAX_SHELL_DEPTH = 4;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** Words that open or close a clause rather than name a program. */
const CLAUSE_WORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "coproc", "function"]);

/** Split a command line into stages of unquoted words.  A stage ends at `;`,
 * `|`, `&`, a newline, a parenthesis, a backtick or `$(`, so a command nested
 * in a substitution is a stage of its own.  Quotes group words and are
 * removed; a backslash makes the next character literal. */
function stagesOf(source: string): string[][] {
  const stages: string[][] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const endStage = () => {
    endWord();
    if (words.length > 0) stages.push(words);
    words = [];
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    // a substitution runs even inside double quotes
    if (ch === "`" || (ch === "$" && source[i + 1] === "(")) {
      quote = null;
      endStage();
      if (ch === "$") i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < source.length) {
        i += 1;
        word += source[i] ?? "";
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\") {
      if (i + 1 < source.length) {
        i += 1;
        word += source[i] ?? "";
        started = true;
      }
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      endStage();
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
    } else {
      word += ch;
      started = true;
    }
  }
  endStage();
  return stages;
}

function firstStageWords(source: string): string[] {
  return stagesOf(source)[0] ?? [];
}

/** `/usr/bin/GIT` and `git.exe` are both `git`. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** Drop leading options, and the value of the ones that take a separate one. */
function skipOptions(words: string[], withValue: ReadonlySet<string>): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    if (word === "--") {
      i += 1;
      break;
    }
    if (!word.startsWith("-") || word === "-") break;
    i += withValue.has(word) ? 2 : 1;
  }
  return words.slice(i);
}

const NO_VALUES: ReadonlySet<string> = new Set();

/** Programs that run the rest of their arguments as a command.  Each takes
 * the words after its own name and returns the words after its options. */
const WRAPPERS = new Map<string, (words: string[]) => string[]>([
  ["sudo", (w) => skipOptions(w, new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group", "--host", "--prompt", "--role", "--type", "--chdir", "--other-user", "--command-timeout", "--close-from"]))],
  ["doas", (w) => skipOptions(w, new Set(["-u", "-C"]))],
  [
    "env",
    (words) => {
      let i = 0;
      while (i < words.length) {
        const word = words[i] ?? "";
        if (word === "--") {
          i += 1;
          break;
        }
        // env -S 'git clean -fd' splits its argument into a command line
        if (word === "-S" || word === "--split-string") return [...firstStageWords(words[i + 1] ?? ""), ...words.slice(i + 2)];
        if (word === "-u" || word === "-C" || word === "--unset" || word === "--chdir") {
          i += 2;
          continue;
        }
        if (word.startsWith("-") && word !== "-") {
          i += 1;
          continue;
        }
        break;
      }
      return words.slice(i);
    },
  ],
  [
    "command",
    (words) => {
      // `command -v git` looks a program up; it does not run it
      if (words.some((word) => word === "-v" || word === "-V")) return [];
      return skipOptions(words, NO_VALUES);
    },
  ],
  ["exec", (w) => skipOptions(w, new Set(["-a"]))],
  ["builtin", (w) => w],
  ["nohup", (w) => skipOptions(w, NO_VALUES)],
  ["setsid", (w) => skipOptions(w, NO_VALUES)],
  ["time", (w) => skipOptions(w, NO_VALUES)],
  ["arch", (w) => skipOptions(w, NO_VALUES)],
  ["nice", (w) => skipOptions(w, new Set(["-n", "--adjustment"]))],
  ["ionice", (w) => skipOptions(w, new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"]))],
  ["caffeinate", (w) => skipOptions(w, new Set(["-t", "-w"]))],
  ["stdbuf", (w) => skipOptions(w, new Set(["-i", "-o", "-e"]))],
  // the duration is the first operand after the options
  ["timeout", (w) => skipOptions(w, new Set(["-k", "-s", "--kill-after", "--signal"])).slice(1)],
  ["xargs", (w) => skipOptions(w, new Set(["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "-J"]))],
]);

interface Peeled {
  /** the program and its arguments, as written */
  words: string[];
  /** an env assignment in the command already named a virtualenv */
  venv: boolean;
}

/** Remove clause words, env assignments and wrapper programs from the front
 * of a stage until the real program is first. */
function peel(tokens: string[]): Peeled {
  let words = tokens;
  let venv = false;
  for (let round = 0; round < 32; round += 1) {
    let i = 0;
    while (i < words.length) {
      const word = words[i] ?? "";
      if (CLAUSE_WORDS.has(word)) i += 1;
      else if (ASSIGNMENT.test(word)) {
        if (word.startsWith("VIRTUAL_ENV=") && word.length > "VIRTUAL_ENV=".length) venv = true;
        i += 1;
      } else break;
    }
    words = words.slice(i);
    const unwrap = WRAPPERS.get(programName(words[0] ?? ""));
    if (!unwrap) break;
    words = unwrap(words.slice(1));
  }
  return { words, venv };
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash"]);

/** The string a shell was asked to run with `-c`, or null when it was not. */
function shellScript(args: string[]): string | null {
  let sawC = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") return sawC ? (args[i + 1] ?? null) : null;
    if (arg === "-o" || arg === "+o" || arg === "-O" || arg === "+O" || arg === "--rcfile" || arg === "--init-file") {
      i += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes("c")) sawC = true;
      continue;
    }
    if (arg.startsWith("-") || arg.startsWith("+")) continue;
    return sawC ? arg : null;
  }
  return null;
}

interface Flags {
  /** long options, as written */
  long: Set<string>;
  /** the letters of every short option cluster */
  short: Set<string>;
  /** everything that is not an option, and everything after `--` */
  operands: string[];
}

function flagsOf(args: string[]): Flags {
  const flags: Flags = { long: new Set(), short: new Set(), operands: [] };
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") options = false;
    else if (options && arg.startsWith("--")) flags.long.add(arg.split("=")[0] ?? arg);
    else if (options && /^-[A-Za-z]+$/.test(arg)) for (const letter of arg.slice(1)) flags.short.add(letter);
    else if (options && arg.startsWith("-") && arg !== "-") continue;
    else flags.operands.push(arg);
  }
  return flags;
}

function firstOperand(args: string[]): string {
  return args.find((arg) => !arg.startsWith("-") && !arg.startsWith("+")) ?? "";
}

/** The pathspecs that mean "the whole tree": `.`, `./`, `*`, `:/`, `..`. */
function wholeTree(operand: string): boolean {
  // magic pathspecs: the top of the repository
  if (operand.startsWith(":")) return /^:(\/\*?|\(top\)\.?\*?)$/.test(operand);
  let spec = operand;
  while (spec.startsWith("./") && spec.length > 2) spec = spec.slice(2);
  spec = spec.replace(/\/+$/, "");
  return /^(\.{1,2}|\*)$/.test(spec);
}

/** git's own options sit between `git` and the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

function gitRisk(args: string[]): CommandRisk | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) i += 2;
    else if (arg.startsWith("-")) i += 1;
    else break;
  }
  const subcommand = args[i] ?? "";
  const flags = flagsOf(args.slice(i + 1));
  switch (subcommand) {
    case "clean":
      // -n only lists what would go
      return flags.long.has("--dry-run") || flags.short.has("n") ? null : destructive("git-clean");
    case "checkout":
      return flags.long.has("--force") || flags.short.has("f") || flags.operands.some(wholeTree)
        ? destructive("git-checkout-discard")
        : null;
    case "restore": {
      // --staged alone only moves the index; the working tree is untouched
      const indexOnly = (flags.long.has("--staged") || flags.short.has("S")) && !flags.long.has("--worktree") && !flags.short.has("W");
      return flags.operands.some(wholeTree) && !indexOnly ? destructive("git-restore-discard") : null;
    }
    case "switch":
      return flags.long.has("--force") || flags.long.has("--discard-changes") || flags.short.has("f")
        ? destructive("git-switch-discard")
        : null;
    default:
      return null;
  }
}

const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

function findRisk(args: string[]): CommandRisk | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "-delete") return destructive("find-delete");
    if (FIND_EXEC.has(arg)) {
      const target = programName(peel(args.slice(i + 1)).words[0] ?? "");
      if (REMOVERS.has(target)) return destructive("find-exec-rm");
    }
  }
  return null;
}

const LAUNCHCTL_READ_ONLY = new Set(["list", "print", "print-cache", "print-disabled", "blame", "dumpstate", "version", "getenv", "managerpid", "manageruid", "managername", "help", "error", "examine", "plist"]);

function launchctlRisk(args: string[]): CommandRisk | null {
  return LAUNCHCTL_READ_ONLY.has(firstOperand(args)) ? null : system("launchctl");
}

function crontabRisk(args: string[]): CommandRisk | null {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "-u") i += 1;
    else rest.push(args[i] ?? "");
  }
  // only listing leaves the table alone
  return rest.length === 1 && rest[0] === "-l" ? null : system("crontab");
}

const GLOBAL_INSTALL = system("global-install");

/** Package-manager subcommands that only read, which stay ordinary with -g. */
const JS_READ_ONLY = new Set(["ls", "list", "ll", "la", "view", "v", "info", "show", "outdated", "root", "bin", "prefix", "search", "s", "find", "help", "why", "explain", "ping", "whoami", "doctor"]);

function jsRisk(program: string, args: string[]): CommandRisk | null {
  // after `--` the flags belong to the script being run, not the manager
  const dashes = args.indexOf("--");
  const own = dashes === -1 ? args : args.slice(0, dashes);
  if (program === "yarn" && own[0] === "global") return ["list", "bin", "dir"].includes(own[1] ?? "") ? null : GLOBAL_INSTALL;
  let global = false;
  for (let i = 0; i < own.length; i += 1) {
    const arg = own[i] ?? "";
    if (arg === "--global" || arg === "--location=global" || (arg === "--location" && own[i + 1] === "global")) global = true;
    else if (arg.startsWith("--global=") && arg !== "--global=false") global = true;
    else if (/^-[A-Za-z]*g[A-Za-z]*$/.test(arg)) global = true;
  }
  return global && !JS_READ_ONLY.has(firstOperand(own)) ? GLOBAL_INSTALL : null;
}

const BREW_MUTATING = new Set(["install", "reinstall", "upgrade", "uninstall", "remove", "rm", "tap", "untap", "link", "unlink", "services", "cleanup", "autoremove", "bundle"]);

/** A python program that is, or sits inside, a virtualenv. */
const VENV_PROGRAM = /(^|[\\/])(\.?v?env|\.?venv[\w.-]*|virtualenv[\w.-]*|\.tox|\.nox)[\\/](bin|Scripts)[\\/][^\\/]*$/i;

function pipRisk(args: string[], word: string, venvEnv: boolean): CommandRisk | null {
  const sub = firstOperand(args);
  if (sub !== "install" && sub !== "uninstall") return null;
  const flags = flagsOf(args);
  // these name a place outside any virtualenv, whatever the environment says
  if (flags.long.has("--user") || flags.long.has("--break-system-packages") || flags.long.has("--system")) return GLOBAL_INSTALL;
  // nothing is written, or it goes to a folder the command names
  if (flags.long.has("--dry-run") || flags.long.has("--target") || flags.short.has("t")) return null;
  // The verdict sees the command, not the shell it runs in, so it cannot tell
  // whether a virtualenv is active.  A bare `pip install` asks; one that
  // names a virtualenv's own pip does not.
  return venvEnv || VENV_PROGRAM.test(word) ? null : GLOBAL_INSTALL;
}

function uvRisk(args: string[]): CommandRisk | null {
  const flags = flagsOf(args);
  if (args[0] === "tool") return ["install", "upgrade", "uninstall"].includes(args[1] ?? "") ? GLOBAL_INSTALL : null;
  if (args[0] === "pip") return flags.long.has("--system") || flags.long.has("--break-system-packages") ? GLOBAL_INSTALL : null;
  return null;
}

const PIPX_MUTATING = new Set(["install", "install-all", "uninstall", "uninstall-all", "upgrade", "upgrade-all", "reinstall", "reinstall-all", "inject", "uninject", "ensurepath"]);
const SYSTEM_PACKAGE_MUTATING = new Set(["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "reinstall", "erase"]);

function riskOfProgram(words: string[], venvEnv: boolean, depth: number): CommandRisk | null {
  const word = words[0] ?? "";
  const program = programName(word);
  const args = words.slice(1);
  if (SHELLS.has(program)) {
    const script = shellScript(args);
    return script === null ? null : unwrapped(script, depth);
  }
  if (program === "su") {
    const at = args.indexOf("-c");
    return at === -1 ? null : unwrapped(args[at + 1] ?? "", depth);
  }
  if (program === "eval") return unwrapped(args.join(" "), depth);
  switch (program) {
    case "git":
      return gitRisk(args);
    case "find":
      return findRisk(args);
    case "truncate":
      return destructive("truncate");
    case "shred":
      return destructive("shred");
    case "pkill":
      return destructive("pkill");
    case "killall":
      return destructive("killall");
    case "launchctl":
      return launchctlRisk(args);
    case "crontab":
      return crontabRisk(args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return jsRisk(program, args);
    case "brew":
      return BREW_MUTATING.has(firstOperand(args)) ? GLOBAL_INSTALL : null;
    case "pip":
    case "pip2":
    case "pip3":
      return pipRisk(args, word, venvEnv);
    case "uv":
      return uvRisk(args);
    case "pipx":
      return PIPX_MUTATING.has(firstOperand(args)) ? GLOBAL_INSTALL : null;
    case "cargo":
      return ["install", "uninstall"].includes(firstOperand(args)) ? GLOBAL_INSTALL : null;
    case "go":
      return firstOperand(args) === "install" ? GLOBAL_INSTALL : null;
    case "gem":
      return ["install", "uninstall", "update"].includes(firstOperand(args)) ? GLOBAL_INSTALL : null;
    case "apt":
    case "apt-get":
    case "aptitude":
    case "dnf":
    case "yum":
      return SYSTEM_PACKAGE_MUTATING.has(firstOperand(args)) ? GLOBAL_INSTALL : null;
    case "apk":
      return ["add", "del", "upgrade"].includes(firstOperand(args)) ? GLOBAL_INSTALL : null;
    default:
      break;
  }
  // python -m pip install ...
  if (/^(python[\d.]*|pypy[\d.]*|py)$/.test(program)) {
    const at = args.indexOf("-m");
    if (at !== -1 && args[at + 1] === "pip") return pipRisk(args.slice(at + 2), word, venvEnv);
  }
  return null;
}

function unwrapped(script: string, depth: number): CommandRisk | null {
  return depth + 1 > MAX_SHELL_DEPTH ? system("nested-shell") : riskIn(script, depth + 1);
}

function riskIn(command: string, depth: number): CommandRisk | null {
  let found: CommandRisk | null = null;
  for (const stage of stagesOf(command)) {
    const { words, venv } = peel(stage);
    if (words.length === 0) continue;
    const risk = riskOfProgram(words, venv, depth);
    if (risk?.kind === "destructive") return risk;
    found ??= risk;
  }
  return found;
}

/** The first risky stage of a command line: destructive ahead of system, or
 * null when every stage is ordinary. */
export function commandRisk(command: string): CommandRisk | null {
  return riskIn(command, 0);
}
