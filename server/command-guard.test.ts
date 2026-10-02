// The command rows that force an approval card in auto mode.  These pin the
// concrete bypass attempts (quotes, wrappers, env prefixes, git global
// options, shell -c, chaining) and the ordinary developer commands that
// must keep auto-approving.
import { describe, expect, it } from "vitest";

import { commandRisk } from "./command-guard.ts";

const destructive: Array<[string, string]> = [
  // git clean
  ["git-clean", "git clean -fd"],
  ["git-clean", "git clean -fdx"],
  ["git-clean", "git clean -f -d"],
  ["git-clean", "git clean --force"],
  ["git-clean", "git clean"],
  // git's own global options sit between "git" and the subcommand
  ["git-clean", "git -C ../other clean -fdx"],
  ["git-clean", "git --git-dir=.git clean -fd"],
  ["git-clean", "git --git-dir .git --work-tree . clean -fd"],
  ["git-clean", "git -c core.quotepath=off clean -ffdx"],
  ["git-clean", "git --no-pager clean -fd"],
  // quoting, escaping, absolute paths and case do not change the program
  ["git-clean", '"git" clean -fd'],
  ["git-clean", "'git' clean -fd"],
  ["git-clean", "\\git clean -fd"],
  ["git-clean", "g''it clean -fd"],
  ["git-clean", "/usr/bin/git clean -fd"],
  ["git-clean", "GIT clean -fd"],
  ["git-clean", 'git "clean" -fd'],
  // env prefixes and wrappers
  ["git-clean", "GIT_DIR=x git clean -fd"],
  ["git-clean", 'FOO="a b" BAR=1 git clean -fd'],
  ["git-clean", "sudo git clean -fd"],
  ["git-clean", "sudo -u root git clean -fd"],
  ["git-clean", "sudo -E -H git clean -fd"],
  ["git-clean", "env FOO=1 git clean -fd"],
  ["git-clean", "env -i git clean -fd"],
  ["git-clean", "/usr/bin/env git clean -fd"],
  ["git-clean", "command git clean -fd"],
  ["git-clean", "nohup git clean -fd"],
  ["git-clean", "time git clean -fd"],
  ["git-clean", "nice -n 10 git clean -fd"],
  ["git-clean", "timeout 30 git clean -fd"],
  ["git-clean", "xargs -n 1 git clean"],
  // shells that take the program as a string
  ["git-clean", "sh -c 'git clean -fdx'"],
  ["git-clean", 'bash -c "git clean -fd"'],
  ["git-clean", 'bash -lc "git clean -fd"'],
  ["git-clean", 'zsh -c "cd x && git clean -fd"'],
  ["git-clean", "sudo sh -c 'git clean -fd'"],
  ["git-clean", "sh -c \"bash -c 'git clean -fd'\""],
  ["git-clean", 'eval "git clean -fd"'],
  ["git-clean", "env -S 'git clean -fd'"],
  // chaining that the shell guard already treats as multi-stage
  ["git-clean", "echo hi && git clean -fd"],
  ["git-clean", "ls; git clean -fd"],
  ["git-clean", "true || git clean -fd"],
  ["git-clean", "cat x | git clean -fd"],
  ["git-clean", "ls\ngit clean -fd"],
  ["git-clean", "(git clean -fd)"],
  ["git-clean", "{ git clean -fd; }"],
  ["git-clean", "if true; then git clean -fd; fi"],
  ["git-clean", "echo $(git clean -fd)"],
  ["git-clean", "x=`git clean -fd`"],
  ["git-clean", 'echo "$(git clean -fd)"'],
  // git checkout and restore over the whole tree
  ["git-checkout-discard", "git checkout ."],
  ["git-checkout-discard", "git checkout -- ."],
  ["git-checkout-discard", "git checkout ./"],
  ["git-checkout-discard", "git checkout HEAD -- ."],
  ["git-checkout-discard", "git checkout :/"],
  ["git-checkout-discard", "git checkout -f"],
  ["git-checkout-discard", "git checkout -f main"],
  ["git-checkout-discard", "git checkout --force main"],
  ["git-checkout-discard", "git -C app checkout ."],
  ["git-checkout-discard", "sudo git checkout ."],
  ["git-restore-discard", "git restore ."],
  ["git-restore-discard", "git restore -- ."],
  ["git-restore-discard", "git restore :/"],
  ["git-restore-discard", "git restore --source=HEAD~1 ."],
  ["git-restore-discard", "git restore --worktree ."],
  ["git-restore-discard", "git restore -W -S ."],
  ["git-switch-discard", "git switch -f main"],
  ["git-switch-discard", "git switch --discard-changes main"],
  // find
  ["find-delete", "find . -name '*.log' -delete"],
  ["find-delete", "find /tmp/x -type f -mtime +7 -delete"],
  ["find-delete", "find . -delete"],
  ["find-exec-rm", "find . -type f -name '*.tmp' -exec rm {} +"],
  ["find-exec-rm", "find . -name '*.tmp' -execdir rm -- {} +"],
  ["find-exec-rm", "find . -name x -exec /bin/rm {} +"],
  // truncate and shred
  ["truncate", "truncate -s 0 app.log"],
  ["truncate", "truncate -s0 app.log"],
  ["truncate", "sudo truncate -s 0 /var/log/x"],
  ["shred", "shred -u secrets.txt"],
  // process killers
  ["pkill", "pkill node"],
  ["pkill", 'pkill -f "vite"'],
  ["pkill", "/usr/bin/pkill foo"],
  ["pkill", "sudo pkill -9 node"],
  ["killall", "killall Dock"],
  ["killall", "sudo killall -9 node"],
  ["pkill", "ls && pkill node"],
  ["pkill", "echo $(pkill node)"],
];

const system: Array<[string, string]> = [
  // launchd and cron
  ["launchctl", "launchctl load ~/Library/LaunchAgents/x.plist"],
  ["launchctl", "launchctl unload -w ~/Library/LaunchAgents/x.plist"],
  ["launchctl", "launchctl bootstrap gui/501 ~/Library/LaunchAgents/x.plist"],
  ["launchctl", "launchctl bootout gui/501/com.example.x"],
  ["launchctl", "launchctl kickstart -k gui/501/com.example.x"],
  ["launchctl", "launchctl enable gui/501/com.example.x"],
  ["launchctl", "launchctl disable gui/501/com.example.x"],
  ["launchctl", "launchctl remove com.example.x"],
  ["launchctl", "launchctl submit -l x -- /bin/sh"],
  ["launchctl", "launchctl setenv PATH /evil"],
  ["launchctl", "sudo launchctl load /Library/LaunchDaemons/x.plist"],
  ["launchctl", "launchctl"],
  ["crontab", "crontab -e"],
  ["crontab", "crontab -r"],
  ["crontab", "crontab mycron"],
  ["crontab", "crontab -"],
  ["crontab", "crontab -u root -r"],
  // npm family, global
  ["global-install", "npm install -g typescript"],
  ["global-install", "npm i -g typescript"],
  ["global-install", "npm install --global typescript"],
  ["global-install", "npm -g install typescript"],
  ["global-install", "npm install --location=global typescript"],
  ["global-install", "npm install --location global typescript"],
  ["global-install", "npm uninstall -g typescript"],
  ["global-install", "npm update -g"],
  ["global-install", "npm install -Dg typescript"],
  ["global-install", "sudo npm i -g typescript"],
  ["global-install", "NODE_ENV=production npm i -g typescript"],
  ["global-install", "pnpm add -g typescript"],
  ["global-install", "pnpm -g add typescript"],
  ["global-install", "pnpm install --global typescript"],
  ["global-install", "yarn global add typescript"],
  ["global-install", "bun add -g typescript"],
  ["global-install", "bun install --global typescript"],
  ["global-install", "sh -c 'npm i -g typescript'"],
  // brew
  ["global-install", "brew install jq"],
  ["global-install", "brew install --cask firefox"],
  ["global-install", "brew reinstall jq"],
  ["global-install", "brew upgrade"],
  ["global-install", "brew uninstall jq"],
  ["global-install", "brew tap homebrew/cask-fonts"],
  ["global-install", "brew services start postgresql"],
  ["global-install", "/opt/homebrew/bin/brew install jq"],
  // pip and friends
  ["global-install", "pip install --user requests"],
  ["global-install", "pip3 install --user requests"],
  ["global-install", "python3 -m pip install --user requests"],
  ["global-install", "pip install --break-system-packages requests"],
  ["global-install", "pip install requests"],
  ["global-install", "pip3 install -r requirements.txt"],
  ["global-install", "python -m pip install requests"],
  ["global-install", "python3.12 -m pip install requests"],
  ["global-install", "sudo pip install requests"],
  ["global-install", "pip uninstall requests"],
  ["global-install", "pipx install httpie"],
  ["global-install", "uv tool install ruff"],
  ["global-install", "uv pip install --system requests"],
  ["global-install", ".venv/bin/pip install --user requests"],
  // other package managers that write outside the project
  ["global-install", "cargo install ripgrep"],
  ["global-install", "go install golang.org/x/tools/gopls@latest"],
  ["global-install", "gem install bundler"],
  ["global-install", "sudo apt-get install -y ripgrep"],
  ["global-install", "apt install ripgrep"],
];

const ordinary = [
  // git
  "git status",
  "git status --short",
  "git log --oneline -20",
  "git diff HEAD~1",
  "git add -A",
  'git commit -m "pkill node and git clean -fd"',
  "git checkout -b feature/auto-approve",
  "git checkout main",
  "git checkout feature/x",
  "git checkout -- src/index.ts",
  "git checkout origin/main -- package.json",
  "git checkout HEAD~1",
  "git restore src/index.ts",
  "git restore --staged src/index.ts",
  "git restore --staged .",
  "git restore -S .",
  "git clean -n",
  "git clean --dry-run -fd",
  "git clean -nd",
  "git clean -dn",
  "git switch main",
  "git switch -c feature/x",
  "git stash",
  "git push origin feature/x",
  'git log --grep="git clean -fd"',
  "git -C ../other status",
  // words that are only arguments
  "grep -rn truncate src",
  "grep -rn pkill scripts/",
  "grep -rn 'brew install' docs",
  'echo "git clean -fd"',
  "echo pkill",
  "cat README.md",
  "man truncate",
  "which pkill",
  // find
  "find . -name '*.ts'",
  "find . -type f -exec wc -l {} +",
  "find . -name x -print",
  "find src -name '*.test.ts' -newer package.json",
  // rm of one file stays ordinary
  "rm build/output.js",
  "ls -la",
  "mkdir -p build",
  "cp a.txt b.txt",
  "mv a.txt b.txt",
  "sed -i '' 's/a/b/' src/index.ts",
  "kill 1234",
  "pgrep node",
  "ps aux",
  // launchd and cron, read only
  "launchctl list",
  "launchctl print gui/501/com.example.x",
  "launchctl print-disabled gui/501",
  "crontab -l",
  "crontab -u jay -l",
  // npm family without a global flag
  "npm install",
  "npm install lodash",
  "npm i -D vitest",
  "npm install --save-dev vitest",
  "npm ci",
  "npm test",
  "npm run build",
  "npm run test -- -g slow",
  "npm test -- --grep slow -g x",
  "npm install --global-style",
  "npm ls -g",
  "npm list --global",
  "npm view react version",
  "pnpm install",
  "pnpm add zod",
  "pnpm -r build",
  "pnpm test",
  "yarn add lodash",
  "yarn install",
  "bun add zod",
  "bun install",
  "npx vitest run",
  // brew, read only
  "brew list",
  "brew info jq",
  "brew search jq",
  "brew --prefix",
  "brew outdated",
  "brew update",
  "brew doctor",
  // python, in a venv or read only
  "pip list",
  "pip freeze",
  "pip show requests",
  "pip --version",
  "pip install --dry-run requests",
  ".venv/bin/pip install requests",
  "./.venv/bin/pip install -r requirements.txt",
  "venv/bin/pip install requests",
  "/Users/jay/proj/.venv/bin/python -m pip install requests",
  "VIRTUAL_ENV=/Users/jay/proj/.venv pip install requests",
  "uv pip install requests",
  "uv add requests",
  "uv run pytest",
  "python3 -m pytest",
  "python script.py",
  "python3 -m venv .venv",
  // other toolchains, project scoped
  "cargo build",
  "cargo test",
  "cargo check",
  "go build ./...",
  "go test ./...",
  "gem list",
  "apt list --installed",
  // noise
  "",
  "   ",
  "\n",
];

describe("commandRisk: destructive rows", () => {
  for (const [rule, command] of destructive) {
    it(`stops ${rule}: ${JSON.stringify(command)}`, () => {
      expect(commandRisk(command)).toEqual({ kind: "destructive", rule });
    });
  }
});

describe("commandRisk: system rows", () => {
  for (const [rule, command] of system) {
    it(`stops ${rule}: ${JSON.stringify(command)}`, () => {
      expect(commandRisk(command)).toEqual({ kind: "system", rule });
    });
  }
});

describe("commandRisk: ordinary developer commands", () => {
  for (const command of ordinary) {
    it(`allows ${JSON.stringify(command)}`, () => {
      expect(commandRisk(command)).toBeNull();
    });
  }
});

describe("commandRisk: edges", () => {
  it("reports a destructive stage ahead of a system one in the same command", () => {
    expect(commandRisk("brew install jq && git clean -fd")).toEqual({ kind: "destructive", rule: "git-clean" });
  });

  it("stays linear on hostile input", () => {
    const started = Date.now();
    const hostile = `${"'".repeat(50_000)} ${"$(".repeat(20_000)} ${'"'.repeat(50_000)} ${"sh -c ".repeat(5_000)}`;
    expect(commandRisk(hostile)).toBeNull();
    expect(commandRisk("sh -c ".repeat(500) + "'git clean -fd'")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fails closed on shells nested past the unwrap depth instead of recursing forever", () => {
    let nested = "git clean -fd";
    for (let i = 0; i < 3; i += 1) nested = `sh -c ${JSON.stringify(nested)}`;
    // three layers still unwrap to the real rule
    expect(commandRisk(nested)).toEqual({ kind: "destructive", rule: "git-clean" });
    for (let i = 0; i < 6; i += 1) nested = `sh -c ${JSON.stringify(nested)}`;
    // nine layers are not something a person typed: ask rather than guess
    expect(commandRisk(nested)).toEqual({ kind: "system", rule: "nested-shell" });
  });
});
