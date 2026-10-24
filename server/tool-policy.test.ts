import { describe, expect, it } from "vitest";

import {
  evaluateArgv,
  evaluateCommand,
  evaluateRead,
  evaluateWrite,
  sanitizeToolPolicy,
  tokenizeCommand,
  tokenizeWrapper,
  unwrapShellCommand,
  type ToolPolicy,
} from "./tool-policy.ts";

const AGENT_SYNC = "/Users/jay/.local/bin/agent-sync";
const OPEN_LOOPS = "/Users/jay/.local/bin/open-loops";
const PYTHON = "/opt/homebrew/bin/python3";
const BACKUP = "/Users/jay/apps/fleet-work-backup/fleet_work_backup.py";
const DM_FILE = "/Users/jay/apps/state/open-loops/dm-today.md";
const LINE_FILE = "/Users/jay/apps/state/plumber/line.md";

/** The shape the open-loops and backup-health routines install. */
function policy(): ToolPolicy {
  return sanitizeToolPolicy({
    mode: "allowlist",
    commands: [
      { argv0: AGENT_SYNC, sub: ["whoami"], flags: { "--json": { value: "none" } } },
      {
        argv0: AGENT_SYNC,
        sub: ["post"],
        flags: { "--topic": { value: "text", required: true }, "--body-file": { value: "path", paths: [LINE_FILE], required: true } },
      },
      {
        argv0: AGENT_SYNC,
        sub: ["read"],
        flags: { "--topic": { value: "text" }, "--json": { value: "none" }, "--limit": { value: "int", min: 1, max: 50 } },
      },
      {
        argv0: AGENT_SYNC,
        sub: ["dm"],
        flags: { "--owner": { value: "none", required: true }, "--body-file": { value: "path", paths: [DM_FILE], required: true } },
      },
      { argv0: OPEN_LOOPS, sub: ["send"], flags: { "--dm-file": { value: "path", paths: [DM_FILE] } } },
      { argv0: PYTHON, sub: [BACKUP, "health"], flags: { "--json": { value: "none" } } },
      {
        argv0: "/usr/bin/tail",
        sub: [],
        flags: { "-n": { value: "int", min: 1, max: 200 } },
        args: [{ value: "path", paths: ["/Users/jay/Library/Logs/fleet-work-backup.log"] }],
      },
      { argv0: "/Users/jay/.local/bin/echo-note", sub: [], flags: {}, positionals: 1 },
      {
        argv0: "/Users/jay/.local/bin/needs-owner",
        sub: ["file"],
        flags: { "--question": { value: "text" }, "--option": { value: "text", repeat: true }, "--by": { value: "oneOf", values: ["BF-PLUMBER"] } },
      },
    ],
    writePaths: [DM_FILE, LINE_FILE],
    readPaths: ["/Users/jay/apps/state/open-loops/facts-today.json"],
  })!;
}

describe("tokenizeCommand", () => {
  it("splits plain words and keeps a quoted topic with spaces as one word", () => {
    expect(tokenizeCommand(`${AGENT_SYNC} read --topic "AFC 29c02bcb fleet-work-backup" --json`)).toEqual({
      ok: true,
      words: [AGENT_SYNC, "read", "--topic", "AFC 29c02bcb fleet-work-backup", "--json"],
    });
    expect(tokenizeCommand(`${AGENT_SYNC} read --topic 'AFC 29c02bcb fleet-work-backup'`)).toMatchObject({
      words: [AGENT_SYNC, "read", "--topic", "AFC 29c02bcb fleet-work-backup"],
    });
  });

  it("treats a quoted ; as text but refuses an unquoted one", () => {
    expect(tokenizeCommand(`${AGENT_SYNC} read --topic "a;b"`)).toMatchObject({ ok: true, words: [AGENT_SYNC, "read", "--topic", "a;b"] });
    expect(tokenizeCommand(`${AGENT_SYNC} whoami --json; touch PWNED`).ok).toBe(false);
  });

  it("concatenates adjacent quoted segments like a shell", () => {
    expect(tokenizeCommand(`a'b c'"d"e`)).toEqual({ ok: true, words: ["ab cde"] });
  });

  it.each([
    ["semicolon", "whoami; touch PWNED"],
    ["and", "whoami && touch PWNED"],
    ["or", "whoami || touch PWNED"],
    ["pipe", "whoami | sh"],
    ["background", "whoami & touch PWNED"],
    ["command substitution", "echo $(touch PWNED)"],
    ["variable", "echo $HOME"],
    ["backticks", "echo `touch PWNED`"],
    ["redirect out", "whoami > /tmp/PWNED"],
    ["redirect append", "whoami >> /tmp/PWNED"],
    ["redirect in", "cat < /etc/passwd"],
    ["subshell", "(touch PWNED)"],
    ["brace group", "{ touch PWNED; }"],
    ["glob star", "cat /Users/jay/.secrets/*"],
    ["glob question", "cat /etc/passw?"],
    ["glob class", "cat /etc/passw[d]"],
    ["tilde", "cat ~/.ssh/id_rsa"],
    ["comment", "whoami # hidden"],
    ["history", "whoami !!"],
    ["backslash escape", "whoami \\; touch PWNED"],
    ["newline", "whoami\ntouch PWNED"],
    ["carriage return", "whoami\rtouch PWNED"],
    ["dollar in double quotes", 'echo "$(touch PWNED)"'],
    ["backtick in double quotes", 'echo "`touch PWNED`"'],
    ["backslash in double quotes", 'echo "a\\"b"'],
    ["unterminated single quote", "echo 'abc"],
    ["unterminated double quote", 'echo "abc'],
    ["nul byte", "whoami\u0000touch"],
    ["escape character", "whoami\u001b[2J"],
    ["unicode line separator", "whoami touch PWNED"],
  ])("refuses %s", (_label, command) => {
    expect(tokenizeCommand(command).ok).toBe(false);
  });

  it("refuses an empty command and an empty quoted word", () => {
    expect(tokenizeCommand("   ").ok).toBe(false);
    expect(tokenizeCommand(`${AGENT_SYNC} read --topic ''`).ok).toBe(false);
  });
});

describe("evaluateCommand: the allowed shapes", () => {
  it("allows each fixed command a routine installs", () => {
    const p = policy();
    for (const command of [
      `${AGENT_SYNC} whoami --json`,
      `${AGENT_SYNC} post --topic "AFC 29c02bcb fleet-work-backup" --body-file ${LINE_FILE}`,
      `${AGENT_SYNC} read --topic "AFC 29c02bcb fleet-work-backup" --json --limit 20`,
      `${AGENT_SYNC} dm --owner --body-file ${DM_FILE}`,
      `${OPEN_LOOPS} send --dm-file ${DM_FILE}`,
      `${PYTHON} ${BACKUP} health --json`,
      "/usr/bin/tail -n 50 /Users/jay/Library/Logs/fleet-work-backup.log",
      `/Users/jay/.local/bin/needs-owner file --by BF-PLUMBER --question "Type the restic key?" --option "Yes, tonight" --option "Later"`,
    ]) {
      expect(evaluateCommand(p, command), command).toMatchObject({ ok: true });
    }
  });

  it("returns the exact argv it allowed, and the words it matched as paths", () => {
    expect(evaluateCommand(policy(), `${AGENT_SYNC} read --topic "a b" --json`)).toEqual({
      ok: true,
      argv: [AGENT_SYNC, "read", "--topic", "a b", "--json"],
      paths: [],
    });
    expect(evaluateCommand(policy(), `${AGENT_SYNC} dm --owner --body-file ${DM_FILE}`)).toMatchObject({ paths: [DM_FILE] });
    expect(evaluateCommand(policy(), "/usr/bin/tail -n 5 /Users/jay/Library/Logs/fleet-work-backup.log")).toMatchObject({
      paths: ["/Users/jay/Library/Logs/fleet-work-backup.log"],
    });
  });
});

describe("evaluateCommand: attacks", () => {
  const p = policy();
  const denied = (command: string) => {
    const decision = evaluateCommand(p, command);
    expect(decision.ok, command).toBe(false);
    if (decision.ok) throw new Error(`allowed: ${command}`);
    return decision;
  };

  it("refuses chaining an allowed command with another:  ; && || | & |&", () => {
    denied(`${AGENT_SYNC} whoami --json; touch PWNED`);
    denied(`${AGENT_SYNC} whoami --json;touch PWNED`);
    denied(`${AGENT_SYNC} whoami --json && touch PWNED`);
    denied(`${AGENT_SYNC} whoami --json || touch PWNED`);
    denied(`${AGENT_SYNC} whoami --json | /bin/sh`);
    denied(`${AGENT_SYNC} whoami --json |& /bin/sh`);
    denied(`${AGENT_SYNC} whoami --json & touch PWNED`);
    denied(`${AGENT_SYNC} whoami --json\ntouch PWNED`);
  });

  it("refuses command substitution:  $() and backticks, bare or inside double quotes", () => {
    denied(`${AGENT_SYNC} whoami --json $(touch PWNED)`);
    denied(`${AGENT_SYNC} whoami --json \`touch PWNED\``);
    denied(`${AGENT_SYNC} read --topic "$(touch PWNED)"`);
    denied(`${AGENT_SYNC} read --topic "\`touch PWNED\`"`);
    denied(`${AGENT_SYNC} read --topic $((1+1))`);
    denied(`${AGENT_SYNC} read --topic \${HOME}`);
    denied(`${AGENT_SYNC} read --topic "\${HOME}"`);
    denied(`/usr/bin/tail -n 50 <(touch PWNED)`);
  });

  it("refuses redirects", () => {
    denied(`${AGENT_SYNC} whoami --json > /tmp/PWNED`);
    denied(`${AGENT_SYNC} whoami --json >/tmp/PWNED`);
    denied(`${AGENT_SYNC} whoami --json >> /tmp/PWNED`);
    denied(`${AGENT_SYNC} whoami --json 1>/tmp/PWNED`);
    denied(`${AGENT_SYNC} whoami --json 2>&1`);
    denied(`${AGENT_SYNC} whoami --json &>/tmp/PWNED`);
    denied(`${AGENT_SYNC} whoami --json >| /tmp/PWNED`);
    denied(`/usr/bin/tail -n 50 < /Users/jay/.secrets/example-credentials`);
    denied(`/usr/bin/tail -n 50 <<< x`);
  });

  it("refuses quoting tricks:  quotes group a word, they never smuggle one", () => {
    // a forbidden flag quoted whole, or split across quoted pieces, is still that flag
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} '--fleet'`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --fl''eet`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --"to" CODEX`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} "--to=CODEX"`);
    // ANSI-C quoting starts with an unquoted $
    denied(`${AGENT_SYNC} whoami --json $'\\x3b' touch PWNED`);
    // a quoted space glues words into one, so the program or verb no longer matches
    denied(`"${AGENT_SYNC} whoami" --json`);
    denied(`${AGENT_SYNC} "whoami --json"`);
    // a quoted ; is text, never a separator:  here it is an extra word, refused
    denied(`${AGENT_SYNC} whoami --json "; touch PWNED"`);
    denied(`${AGENT_SYNC} whoami "--json;touch" PWNED`);
    // a quote-concatenated ../ is still a different path
    denied(`${AGENT_SYNC} dm --owner --body-file "/Users/jay/apps/state/open-loops/"'..'"/../../.secrets/x"`);
    // typographic quotes and a no-break space are not quotes or spaces at all
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} “--fleet”`);
    denied(`${AGENT_SYNC} whoami --json`);
    // a backslash or ! inside double quotes, which a shell would still act on
    denied(`${AGENT_SYNC} read --topic "a\\"b"`);
    denied(`${AGENT_SYNC} read --topic "a!b"`);
    // quoting the listed program itself changes nothing:  the same argv is allowed
    expect(evaluateCommand(p, `'${AGENT_SYNC}' whoami "--json"`)).toEqual({ ok: true, argv: [AGENT_SYNC, "whoami", "--json"], paths: [] });
  });

  it("refuses a bare command with no path, the shape an engine's own allow rules auto-run", () => {
    expect(denied("touch PWNED").reason).toMatch(/absolute/);
    denied("whoami");
    denied("gh pr merge 1 --admin");
    denied("gh --version");
    denied("agent-sync whoami --json");
  });

  it("refuses an unlisted program and an unlisted verb of a listed one", () => {
    denied("/usr/bin/touch /tmp/PWNED");
    denied("/bin/sh -c whoami");
    denied(`${AGENT_SYNC} subscribe --channel x`);
    denied(`${OPEN_LOOPS} gather --json`);
  });

  it("refuses path tricks on the program", () => {
    denied("/Users/jay/.local/bin/../bin/agent-sync whoami --json");
    denied("/Users/jay/.local/bin/./agent-sync whoami --json");
    denied("/Users/jay//.local/bin/agent-sync whoami --json");
    denied("/tmp/agent-sync whoami --json");
  });

  it("refuses an environment prefix", () => {
    expect(denied(`PATH=/tmp ${AGENT_SYNC} whoami --json`).name).toBe("env-prefix");
    denied(`AGENT_LAUNCH_SEAT=CLAUDE ${AGENT_SYNC} whoami --json`);
    denied(`/usr/bin/env AGENT_SEAT=CLAUDE ${AGENT_SYNC} whoami --json`);
  });

  it("refuses long-option smuggling", () => {
    // argparse expands an unambiguous prefix, so every abbreviation is refused
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --fleet`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --fl`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --to CODEX`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --to-owner`);
    denied(`${AGENT_SYNC} whoami --json --as CLAUDE`);
    denied(`${AGENT_SYNC.replace("agent-sync", "AGENT-SYNC")} whoami --json --as CLAUDE`);
    denied(`${AGENT_SYNC} whoami --json --a CLAUDE`);
    denied(`${AGENT_SYNC} whoami --json --rc /tmp/other-zuliprc`);
    denied(`${AGENT_SYNC} whoami --json --default-seat MM`);
    denied(`${AGENT_SYNC} whoami --json --session x`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --no-tag`);
    // --flag=value is refused outright, so `--to=X` cannot slip past a check on `--to`
    denied(`${AGENT_SYNC} post --topic=t --body-file ${LINE_FILE}`);
    denied(`${AGENT_SYNC} post --topic t --body-file ${LINE_FILE} --to=CODEX`);
    // an end-of-options marker
    denied(`${AGENT_SYNC} read -- --fleet`);
    // a value that is really a flag
    denied(`${AGENT_SYNC} read --topic --fleet`);
    // an unlisted flag, and a repeated one
    denied(`${AGENT_SYNC} whoami --json --verbose`);
    denied(`${AGENT_SYNC} whoami --json --json`);
    // a combined short flag
    denied("/usr/bin/tail -n50 /tmp/x");
    denied("/usr/bin/tail -fn 50 /tmp/x");
  });

  it("keeps agent-sync's rules for agent-sync in another letter case or run by an interpreter", () => {
    // Built by hand:  sanitizeToolPolicy refuses these entries, and the run-time check must hold alone.
    const unchecked: ToolPolicy = {
      mode: "allowlist",
      commands: [
        { argv0: "/Users/jay/.local/bin/Agent-Sync", sub: ["post"], flags: { "--as": { value: "text" }, "--topic": { value: "text" } }, args: [], positionals: 0 },
        { argv0: PYTHON, sub: ["/Users/jay/apps/fleet/agent-sync", "dm"], flags: { "--to": { value: "text" } }, args: [], positionals: 0 },
      ],
      writePaths: [],
      readPaths: [],
    };
    expect(evaluateCommand(unchecked, "/Users/jay/.local/bin/Agent-Sync post --topic t --as CLAUDE").ok).toBe(false);
    expect(evaluateCommand(unchecked, "/Users/jay/.local/bin/Agent-Sync post --topic t")).toMatchObject({ ok: true });
    expect(evaluateCommand(unchecked, `${PYTHON} /Users/jay/apps/fleet/agent-sync dm --to CODEX`).ok).toBe(false);
  });

  it("refuses a direct message to anyone but the owner", () => {
    denied(`${AGENT_SYNC} dm --body-file ${DM_FILE}`);
    denied(`${AGENT_SYNC} dm --owner --to CODEX --body-file ${DM_FILE}`);
    denied(`${AGENT_SYNC} dm --owner --body-file ${DM_FILE} hello`);
  });

  it("refuses a path flag naming any other file", () => {
    denied(`${AGENT_SYNC} dm --owner --body-file /Users/jay/.secrets/example-credentials`);
    denied(`${AGENT_SYNC} dm --owner --body-file /Users/jay/apps/state/open-loops/../../../.secrets/x`);
    denied(`${OPEN_LOOPS} send --dm-file /tmp/dm.md`);
  });

  it("refuses bad values and extra words", () => {
    denied(`${AGENT_SYNC} read --topic t --limit 500`);
    denied(`${AGENT_SYNC} read --topic t --limit -1`);
    denied(`${AGENT_SYNC} read --topic t --limit 1e3`);
    denied(`${AGENT_SYNC} whoami --json extra`);
    denied("/usr/bin/tail -n 50 /Users/jay/Library/Logs/fleet-work-backup.log /tmp/b");
    denied("/usr/bin/tail -n 50");
    denied(`/Users/jay/.local/bin/echo-note "one" "two"`);
    denied(`/Users/jay/.local/bin/needs-owner file --by BF-DEPLOYER --question q`);
    // an argparse fromfile word
    denied("/usr/bin/tail -n 50 @/Users/jay/.secrets/example-credentials");
    denied(`/Users/jay/.local/bin/echo-note @/etc/passwd`);
    denied(`/Users/jay/.local/bin/needs-owner file --question @/etc/passwd`);
  });

  it("refuses a positional word naming any file but the declared one", () => {
    // the hole a bare positional count leaves:  tail would read any file
    denied("/usr/bin/tail -n 50 /Users/jay/.secrets/example-credentials");
    denied("/usr/bin/tail -n 200 /etc/passwd");
    denied("/usr/bin/tail -n 50 /Users/jay/Library/Logs/../../.secrets/example-credentials");
    expect(evaluateCommand(p, "/usr/bin/tail -n 50 /Users/jay/Library/Logs/fleet-work-backup.log")).toMatchObject({ ok: true });
    expect(evaluateCommand(p, `/Users/jay/.local/bin/echo-note "a note"`)).toMatchObject({ ok: true });
  });

  it("refuses the wrong fixed words for an interpreter", () => {
    denied(`${PYTHON} ${BACKUP} prune --json`);
    denied(`${PYTHON} -c "import os"`);
    denied(`${PYTHON} /tmp/evil.py health --json`);
  });

  it("names only the program in a denial, never its arguments", () => {
    const decision = denied(`${AGENT_SYNC} whoami --json; cat /Users/jay/.secrets/example-credentials`);
    expect(decision.name).toBe("agent-sync");
    expect(JSON.stringify(decision)).not.toContain("secrets");
  });
});

describe("evaluateArgv", () => {
  it("applies the same rules to an argv an engine passes as a list", () => {
    expect(evaluateArgv(policy(), [AGENT_SYNC, "whoami", "--json"])).toMatchObject({ ok: true });
    expect(evaluateArgv(policy(), [AGENT_SYNC, "whoami", "--json", ";", "touch", "PWNED"]).ok).toBe(false);
    expect(evaluateArgv(policy(), ["touch", "PWNED"]).ok).toBe(false);
  });
});

describe("unwrapShellCommand", () => {
  it("unwraps the bash -lc wrapper an engine builds, including the '\"'\"' idiom", () => {
    expect(unwrapShellCommand(`/opt/homebrew/bin/bash -lc '${AGENT_SYNC} whoami --json'`)).toEqual({
      command: `${AGENT_SYNC} whoami --json`,
    });
    expect(unwrapShellCommand(`/bin/bash -lc '${AGENT_SYNC} read --topic '"'"'a b'"'"''`)).toEqual({
      command: `${AGENT_SYNC} read --topic 'a b'`,
    });
    expect(unwrapShellCommand("/bin/sh", ["-c", "touch PWNED"])).toEqual({ command: "touch PWNED" });
  });

  it("refuses a wrapper of any other shape, and an outer expansion", () => {
    expect(unwrapShellCommand(`/bin/bash -lc 'a' extra`)).toBeNull();
    expect(unwrapShellCommand(`/bin/bash -i -c 'a'`)).toBeNull();
    expect(unwrapShellCommand(`/bin/bash -lc "$(touch PWNED)"`)).toBeNull();
    expect(tokenizeWrapper(`/bin/bash -lc 'a'; touch PWNED`)).toBeNull();
  });

  it("passes a plain command through for the strict check", () => {
    expect(unwrapShellCommand(`${AGENT_SYNC} whoami --json`)).toEqual({ command: `${AGENT_SYNC} whoami --json` });
  });

  it("reads a double-quoted wrapper the way bash does, and the strict check still refuses what it carries", () => {
    // An engine escapes inner quotes with \" in a double-quoted wrapper, so the
    // wrapper accepts that escape (and a literal !, which bash -c never expands).
    // The inner command then meets tokenizeCommand, which refuses \ and ! inside
    // double quotes, and nothing is ever handed to a shell.
    const inner = (wrapper: string): string => {
      const unwrapped = unwrapShellCommand(wrapper);
      if (!unwrapped || !("command" in unwrapped)) throw new Error(`not unwrapped: ${wrapper}`);
      return unwrapped.command;
    };
    const quoted = inner(`/bin/bash -lc "${AGENT_SYNC} read --topic \\"a b\\""`);
    expect(quoted).toBe(`${AGENT_SYNC} read --topic "a b"`);
    expect(evaluateCommand(policy(), quoted)).toMatchObject({ ok: true });
    for (const wrapper of [
      `/bin/bash -lc "${AGENT_SYNC} read --topic \\"a!b\\""`,
      `/bin/bash -lc "${AGENT_SYNC} read --topic \\"a\\\\\\"b\\""`,
      `/bin/bash -lc "${AGENT_SYNC} read --topic \\"\\$(touch PWNED)\\""`,
      `/bin/bash -lc "${AGENT_SYNC} whoami --json \\\`touch PWNED\\\`"`,
    ]) {
      expect(evaluateCommand(policy(), inner(wrapper)).ok, wrapper).toBe(false);
    }
  });
});

describe("files", () => {
  it("allows exactly the listed write paths", () => {
    expect(evaluateWrite(policy(), DM_FILE)).toMatchObject({ ok: true });
    expect(evaluateWrite(policy(), "/Users/jay/apps/state/open-loops/other.md").ok).toBe(false);
    expect(evaluateWrite(policy(), "/Users/jay/apps/state/open-loops/../plumber/line.md").ok).toBe(false);
    expect(evaluateWrite(policy(), "/Users/jay/apps/state/open-loops/").ok).toBe(false);
    expect(evaluateWrite(policy(), "dm-today.md").ok).toBe(false);
    expect(evaluateWrite(policy(), "/Users/jay/.zshrc").ok).toBe(false);
  });

  it("matches a write through the resolved parent the engine reports", () => {
    const canonical = (configured: string) => configured.replace("/Users/jay/apps", "/Volumes/Data/apps");
    expect(evaluateWrite(policy(), "/Volumes/Data/apps/state/open-loops/dm-today.md", canonical)).toEqual({ ok: true, argv: [DM_FILE] });
    expect(evaluateWrite(policy(), "/Volumes/Data/apps/state/open-loops/x.md", canonical).ok).toBe(false);
  });

  it("reads only write paths and read paths", () => {
    expect(evaluateRead(policy(), DM_FILE)).toMatchObject({ ok: true });
    expect(evaluateRead(policy(), "/Users/jay/apps/state/open-loops/facts-today.json")).toMatchObject({ ok: true });
    expect(evaluateRead(policy(), "/Users/jay/.secrets/example-credentials").ok).toBe(false);
    expect(evaluateRead(policy(), "/etc/hosts").ok).toBe(false);
  });

  it("refuses a folded LaunchAgents spelling at save time", () => {
    expect(() =>
      sanitizeToolPolicy({
        mode: "allowlist",
        commands: [],
        writePaths: ["/Users/me/library/launchagents/persist.plist"],
      }),
    ).toThrow(/Command allowlist/);
  });
});

describe("sanitizeToolPolicy", () => {
  it("round-trips a valid policy and treats null as no policy", () => {
    const clean = policy();
    expect(sanitizeToolPolicy(JSON.parse(JSON.stringify(clean)))).toEqual(clean);
    expect(sanitizeToolPolicy(undefined)).toBeUndefined();
    expect(sanitizeToolPolicy(null)).toBeUndefined();
  });

  it.each([
    ["a mode other than allowlist", { mode: "denylist", commands: [] }],
    ["an unknown top-level field", { mode: "allowlist", commands: [], extra: 1 }],
    ["a relative program", { mode: "allowlist", commands: [{ argv0: "agent-sync", sub: [] }] }],
    ["a program with ..", { mode: "allowlist", commands: [{ argv0: "/usr/../bin/sh", sub: [] }] }],
    ["a program with a space", { mode: "allowlist", commands: [{ argv0: "/usr/bin/my tool", sub: [] }] }],
    ["a sub word that is a flag", { mode: "allowlist", commands: [{ argv0: "/bin/x", sub: ["-c"] }] }],
    ["a sub word with a metacharacter", { mode: "allowlist", commands: [{ argv0: "/bin/x", sub: ["a;b"] }] }],
    ["a bad flag name", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "json": { value: "none" } } }] }],
    ["an unknown value kind", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "regex" } } }] }],
    ["a relative path flag", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "path", paths: ["a.md"] } } }] }],
    ["agent-sync --fleet", { mode: "allowlist", commands: [{ argv0: AGENT_SYNC, sub: ["post"], flags: { "--fleet": { value: "none" } } }] }],
    ["agent-sync --to", { mode: "allowlist", commands: [{ argv0: AGENT_SYNC, sub: ["post"], flags: { "--to": { value: "text" } } }] }],
    ["agent-sync --as", { mode: "allowlist", commands: [{ argv0: AGENT_SYNC, sub: ["whoami"], flags: { "--as": { value: "text" } } }] }],
    ["an abbreviation of a forbidden agent-sync flag", { mode: "allowlist", commands: [{ argv0: AGENT_SYNC, sub: ["post"], flags: { "--fl": { value: "none" } } }] }],
    ["agent-sync dm without a required --owner", { mode: "allowlist", commands: [{ argv0: AGENT_SYNC, sub: ["dm"], flags: { "--owner": { value: "none" } } }] }],
    ["a directory write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/apps/state/"] }],
    ["a relative write path", { mode: "allowlist", commands: [], writePaths: ["state/dm.md"] }],
    ["a glob write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/apps/state/*.md"] }],
    ["a dotfile write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.zshrc"] }],
    ["a write path in a dot directory", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.local/state/x.md"] }],
    ["a credential directory write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.secrets/zulip"] }],
    ["a LaunchAgents write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/Library/LaunchAgents/x.plist"] }],
    ["a LaunchAgents write path with folded case", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/library/launchagents/x.plist"] }],
    ["agent-sync --as through a case-folded argv0", { mode: "allowlist", commands: [{ argv0: "/Users/jay/.local/bin/AGENT-SYNC", sub: ["whoami"], flags: { "--as": { value: "text" } } }] }],
    ["too many positionals", { mode: "allowlist", commands: [{ argv0: "/bin/x", positionals: 99 }] }],
    ["a positional switch", { mode: "allowlist", commands: [{ argv0: "/bin/x", args: [{ value: "none" }] }] }],
    ["a relative positional path", { mode: "allowlist", commands: [{ argv0: "/bin/x", args: [{ value: "path", paths: ["log.txt"] }] }] }],
    ["a path flag naming a credential file", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "path", paths: ["/Users/jay/.ssh/id_ed25519"] } } }] }],
    ["a path flag naming a dotfile", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "path", paths: ["/Users/jay/.zshrc"] } } }] }],
    ["a positional path under a credential directory", { mode: "allowlist", commands: [{ argv0: "/usr/bin/tail", args: [{ value: "path", paths: ["/Users/jay/.secrets/example-credentials"] }] }] }],
    ["a positional path under LaunchAgents", { mode: "allowlist", commands: [{ argv0: "/bin/cat", args: [{ value: "path", paths: ["/Users/jay/Library/LaunchAgents/x.plist"] }] }] }],
    ["a read path in a dot directory", { mode: "allowlist", commands: [], readPaths: ["/Users/jay/.grok/auth.json"] }],
    ["a read path under a credential directory", { mode: "allowlist", commands: [], readPaths: ["/Users/jay/.config/gh/hosts.yml"] }],
    ["a write path under LaunchAgents in another letter case", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/library/launchagents/x.plist"] }],
    ["a positional path under LaunchDaemons in another letter case", { mode: "allowlist", commands: [{ argv0: "/bin/cat", args: [{ value: "path", paths: ["/LIBRARY/LAUNCHDAEMONS/x.plist"] }] }] }],
    ["agent-sync named in another letter case, with --as", { mode: "allowlist", commands: [{ argv0: "/Users/jay/.local/bin/Agent-Sync", sub: ["whoami"], flags: { "--as": { value: "text" } } }] }],
    ["agent-sync run by an interpreter, with --to", { mode: "allowlist", commands: [{ argv0: PYTHON, sub: ["/Users/jay/apps/fleet/agent-sync", "post"], flags: { "--to": { value: "text" } } }] }],
    ["agent-sync dm run by an interpreter without a required --owner", { mode: "allowlist", commands: [{ argv0: PYTHON, sub: ["/Users/jay/apps/fleet/agent-sync", "dm"], flags: { "--owner": { value: "none" } } }] }],
  ])("refuses %s", (_label, raw) => {
    expect(() => sanitizeToolPolicy(raw)).toThrow(/Command allowlist/);
  });
});
