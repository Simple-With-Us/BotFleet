import { describe, expect, it } from "vitest";

import {
  evaluateArgv,
  evaluateCommand,
  evaluateRead,
  evaluateWrite,
  namesChatCli,
  sanitizeToolPolicy,
  tokenizeCommand,
  tokenizeWrapper,
  unwrapShellCommand,
  type ToolPolicy,
} from "./tool-policy.ts";

const SIMPLE_CHAT = "/Users/jay/.local/bin/simple-chat";
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
      { argv0: SIMPLE_CHAT, sub: ["whoami"], flags: { "--json": { value: "none" } } },
      {
        argv0: SIMPLE_CHAT,
        sub: ["post"],
        flags: { "--topic": { value: "text", required: true }, "--body-file": { value: "path", paths: [LINE_FILE], required: true } },
      },
      {
        argv0: SIMPLE_CHAT,
        sub: ["read"],
        flags: { "--topic": { value: "text" }, "--json": { value: "none" }, "--limit": { value: "int", min: 1, max: 50 } },
      },
      {
        argv0: SIMPLE_CHAT,
        sub: ["dm"],
        flags: { "--owner": { value: "none", required: true }, "--body-file": { value: "path", paths: [DM_FILE], required: true } },
      },
      { argv0: SIMPLE_CHAT, sub: ["whoami"], flags: { "--json": { value: "none" } } },
      {
        argv0: SIMPLE_CHAT,
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
    expect(tokenizeCommand(`${SIMPLE_CHAT} read --topic "AFC 29c02bcb fleet-work-backup" --json`)).toEqual({
      ok: true,
      words: [SIMPLE_CHAT, "read", "--topic", "AFC 29c02bcb fleet-work-backup", "--json"],
    });
    expect(tokenizeCommand(`${SIMPLE_CHAT} read --topic 'AFC 29c02bcb fleet-work-backup'`)).toMatchObject({
      words: [SIMPLE_CHAT, "read", "--topic", "AFC 29c02bcb fleet-work-backup"],
    });
  });

  it("treats a quoted ; as text but refuses an unquoted one", () => {
    expect(tokenizeCommand(`${SIMPLE_CHAT} read --topic "a;b"`)).toMatchObject({ ok: true, words: [SIMPLE_CHAT, "read", "--topic", "a;b"] });
    expect(tokenizeCommand(`${SIMPLE_CHAT} whoami --json; touch PWNED`).ok).toBe(false);
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
    expect(tokenizeCommand(`${SIMPLE_CHAT} read --topic ''`).ok).toBe(false);
  });
});

describe("evaluateCommand: the allowed shapes", () => {
  it("allows each fixed command a routine installs", () => {
    const p = policy();
    for (const command of [
      `${SIMPLE_CHAT} whoami --json`,
      `${SIMPLE_CHAT} post --topic "AFC 29c02bcb fleet-work-backup" --body-file ${LINE_FILE}`,
      `${SIMPLE_CHAT} read --topic "AFC 29c02bcb fleet-work-backup" --json --limit 20`,
      `${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE}`,
      `${SIMPLE_CHAT} whoami --json`,
      `${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE}`,
      `${OPEN_LOOPS} send --dm-file ${DM_FILE}`,
      `${PYTHON} ${BACKUP} health --json`,
      "/usr/bin/tail -n 50 /Users/jay/Library/Logs/fleet-work-backup.log",
      `/Users/jay/.local/bin/needs-owner file --by BF-PLUMBER --question "Type the restic key?" --option "Yes, tonight" --option "Later"`,
    ]) {
      expect(evaluateCommand(p, command), command).toMatchObject({ ok: true });
    }
  });

  it("returns the exact argv it allowed, and the words it matched as paths", () => {
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} read --topic "a b" --json`)).toEqual({
      ok: true,
      argv: [SIMPLE_CHAT, "read", "--topic", "a b", "--json"],
      paths: [],
    });
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE}`)).toMatchObject({ paths: [DM_FILE] });
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
    denied(`${SIMPLE_CHAT} whoami --json; touch PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json;touch PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json && touch PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json || touch PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json | /bin/sh`);
    denied(`${SIMPLE_CHAT} whoami --json |& /bin/sh`);
    denied(`${SIMPLE_CHAT} whoami --json & touch PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json\ntouch PWNED`);
  });

  it("refuses command substitution:  $() and backticks, bare or inside double quotes", () => {
    denied(`${SIMPLE_CHAT} whoami --json $(touch PWNED)`);
    denied(`${SIMPLE_CHAT} whoami --json \`touch PWNED\``);
    denied(`${SIMPLE_CHAT} read --topic "$(touch PWNED)"`);
    denied(`${SIMPLE_CHAT} read --topic "\`touch PWNED\`"`);
    denied(`${SIMPLE_CHAT} read --topic $((1+1))`);
    denied(`${SIMPLE_CHAT} read --topic \${HOME}`);
    denied(`${SIMPLE_CHAT} read --topic "\${HOME}"`);
    denied(`/usr/bin/tail -n 50 <(touch PWNED)`);
  });

  it("refuses redirects", () => {
    denied(`${SIMPLE_CHAT} whoami --json > /tmp/PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json >/tmp/PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json >> /tmp/PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json 1>/tmp/PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json 2>&1`);
    denied(`${SIMPLE_CHAT} whoami --json &>/tmp/PWNED`);
    denied(`${SIMPLE_CHAT} whoami --json >| /tmp/PWNED`);
    denied(`/usr/bin/tail -n 50 < /Users/jay/.secrets/example-credentials`);
    denied(`/usr/bin/tail -n 50 <<< x`);
  });

  it("refuses quoting tricks:  quotes group a word, they never smuggle one", () => {
    // a forbidden flag quoted whole, or split across quoted pieces, is still that flag
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} '--fleet'`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --fl''eet`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --"to" CODEX`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} "--to=CODEX"`);
    // ANSI-C quoting starts with an unquoted $
    denied(`${SIMPLE_CHAT} whoami --json $'\\x3b' touch PWNED`);
    // a quoted space glues words into one, so the program or verb no longer matches
    denied(`"${SIMPLE_CHAT} whoami" --json`);
    denied(`${SIMPLE_CHAT} "whoami --json"`);
    // a quoted ; is text, never a separator:  here it is an extra word, refused
    denied(`${SIMPLE_CHAT} whoami --json "; touch PWNED"`);
    denied(`${SIMPLE_CHAT} whoami "--json;touch" PWNED`);
    // a quote-concatenated ../ is still a different path
    denied(`${SIMPLE_CHAT} dm --owner --body-file "/Users/jay/apps/state/open-loops/"'..'"/../../.secrets/x"`);
    // typographic quotes and a no-break space are not quotes or spaces at all
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} “--fleet”`);
    denied(`${SIMPLE_CHAT} whoami --json`);
    // a backslash or ! inside double quotes, which a shell would still act on
    denied(`${SIMPLE_CHAT} read --topic "a\\"b"`);
    denied(`${SIMPLE_CHAT} read --topic "a!b"`);
    // quoting the listed program itself changes nothing:  the same argv is allowed
    expect(evaluateCommand(p, `'${SIMPLE_CHAT}' whoami "--json"`)).toEqual({ ok: true, argv: [SIMPLE_CHAT, "whoami", "--json"], paths: [] });
  });

  it("refuses a bare command with no path, the shape an engine's own allow rules auto-run", () => {
    expect(denied("touch PWNED").reason).toMatch(/absolute/);
    denied("whoami");
    denied("gh pr merge 1 --admin");
    denied("gh --version");
    denied("simple-chat whoami --json");
  });

  it("refuses an unlisted program and an unlisted verb of a listed one", () => {
    denied("/usr/bin/touch /tmp/PWNED");
    denied("/bin/sh -c whoami");
    denied(`${SIMPLE_CHAT} subscribe --channel x`);
    denied(`${OPEN_LOOPS} gather --json`);
  });

  it("refuses path tricks on the program", () => {
    denied("/Users/jay/.local/bin/../bin/simple-chat whoami --json");
    denied("/Users/jay/.local/bin/./simple-chat whoami --json");
    denied("/Users/jay//.local/bin/simple-chat whoami --json");
    denied("/tmp/simple-chat whoami --json");
  });

  it("refuses an environment prefix", () => {
    expect(denied(`PATH=/tmp ${SIMPLE_CHAT} whoami --json`).name).toBe("env-prefix");
    denied(`AGENT_LAUNCH_SEAT=CLAUDE ${SIMPLE_CHAT} whoami --json`);
    denied(`/usr/bin/env AGENT_SEAT=CLAUDE ${SIMPLE_CHAT} whoami --json`);
  });

  it("refuses long-option smuggling", () => {
    // argparse expands an unambiguous prefix, so every abbreviation is refused
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --fleet`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --fl`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --to CODEX`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --to-owner`);
    denied(`${SIMPLE_CHAT} whoami --json --as CLAUDE`);
    denied(`${SIMPLE_CHAT.replace("simple-chat", "SIMPLE-CHAT")} whoami --json --as CLAUDE`);
    denied(`${SIMPLE_CHAT} whoami --json --a CLAUDE`);
    denied(`${SIMPLE_CHAT} whoami --json --rc /tmp/other-zuliprc`);
    denied(`${SIMPLE_CHAT} whoami --json --default-seat MM`);
    denied(`${SIMPLE_CHAT} whoami --json --session x`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --no-tag`);
    // --flag=value is refused outright, so `--to=X` cannot slip past a check on `--to`
    denied(`${SIMPLE_CHAT} post --topic=t --body-file ${LINE_FILE}`);
    denied(`${SIMPLE_CHAT} post --topic t --body-file ${LINE_FILE} --to=CODEX`);
    // an end-of-options marker
    denied(`${SIMPLE_CHAT} read -- --fleet`);
    // a value that is really a flag
    denied(`${SIMPLE_CHAT} read --topic --fleet`);
    // an unlisted flag, and a repeated one
    denied(`${SIMPLE_CHAT} whoami --json --verbose`);
    denied(`${SIMPLE_CHAT} whoami --json --json`);
    // a combined short flag
    denied("/usr/bin/tail -n50 /tmp/x");
    denied("/usr/bin/tail -fn 50 /tmp/x");
  });

  it("keeps the chat CLI's rules for simple-chat, the name the fleet uses now", () => {
    // A policy that allows exactly what the chat CLI must never take, so the
    // refusal can only come from the CLI's own rules.
    const unchecked: ToolPolicy = {
      mode: "allowlist",
      commands: [
        { argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--as": { value: "text" }, "--topic": { value: "text" } }, args: [], positionals: 0 },
        { argv0: SIMPLE_CHAT, sub: ["dm"], flags: { "--owner": { value: "none" }, "--body-file": { value: "path", paths: [DM_FILE] } }, args: [], positionals: 0 },
        { argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--as": { value: "text" }, "--topic": { value: "text" } }, args: [], positionals: 0 },
      ],
      writePaths: [],
      readPaths: [],
    };
    const forbidden = evaluateCommand(unchecked, `${SIMPLE_CHAT} post --topic t --as CLAUDE`);
    expect(forbidden.ok).toBe(false);
    if (forbidden.ok) throw new Error("allowed:  simple-chat --as");
    expect(forbidden.reason).toContain("may never take --as");
    const dm = evaluateCommand(unchecked, `${SIMPLE_CHAT} dm --body-file ${DM_FILE}`);
    expect(dm.ok).toBe(false);
    if (dm.ok) throw new Error("allowed:  simple-chat dm without --owner");
    expect(dm.reason).toContain("dm is allowed only with --owner");
    // the saved policy's own rules hold for the current name too
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} whoami --json --as CLAUDE`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} post --topic t --to CODEX`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} post --topic t --fl`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --body-file ${DM_FILE}`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --as CODEX --body-file ${DM_FILE}`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE}`)).toMatchObject({ ok: true });
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} whoami --json --as CLAUDE`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --body-file ${DM_FILE}`).ok).toBe(false);
    expect(evaluateCommand(policy(), `${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE}`)).toMatchObject({ ok: true });
  });

  it("keeps the chat CLI's rules in another letter case or run by an interpreter", () => {
    // Built by hand:  sanitizeToolPolicy refuses these entries, and the run-time check must hold alone.
    const unchecked: ToolPolicy = {
      mode: "allowlist",
      commands: [
        { argv0: "/Users/jay/.local/bin/Simple-Chat", sub: ["post"], flags: { "--as": { value: "text" }, "--topic": { value: "text" } }, args: [], positionals: 0 },
        { argv0: PYTHON, sub: ["/Users/jay/apps/fleet/simple-chat", "dm"], flags: { "--to": { value: "text" } }, args: [], positionals: 0 },
      ],
      writePaths: [],
      readPaths: [],
    };
    expect(evaluateCommand(unchecked, "/Users/jay/.local/bin/Simple-Chat post --topic t --as CLAUDE").ok).toBe(false);
    expect(evaluateCommand(unchecked, "/Users/jay/.local/bin/Simple-Chat post --topic t")).toMatchObject({ ok: true });
    expect(evaluateCommand(unchecked, `${PYTHON} /Users/jay/apps/fleet/simple-chat dm --to CODEX`).ok).toBe(false);
  });

  it("names the current CLI in every refusal", () => {
    const refusal = evaluateCommand(policy(), `${SIMPLE_CHAT} whoami --json --as CLAUDE`);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("allowed:  simple-chat --as");
    expect(refusal.reason).toContain("simple-chat");
  });


  it("refuses a direct message to anyone but the owner", () => {
    denied(`${SIMPLE_CHAT} dm --body-file ${DM_FILE}`);
    denied(`${SIMPLE_CHAT} dm --owner --to CODEX --body-file ${DM_FILE}`);
    denied(`${SIMPLE_CHAT} dm --owner --body-file ${DM_FILE} hello`);
  });

  it("refuses a path flag naming any other file", () => {
    denied(`${SIMPLE_CHAT} dm --owner --body-file /Users/jay/.secrets/example-credentials`);
    denied(`${SIMPLE_CHAT} dm --owner --body-file /Users/jay/apps/state/open-loops/../../../.secrets/x`);
    denied(`${OPEN_LOOPS} send --dm-file /tmp/dm.md`);
  });

  it("refuses bad values and extra words", () => {
    denied(`${SIMPLE_CHAT} read --topic t --limit 500`);
    denied(`${SIMPLE_CHAT} read --topic t --limit -1`);
    denied(`${SIMPLE_CHAT} read --topic t --limit 1e3`);
    denied(`${SIMPLE_CHAT} whoami --json extra`);
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
    const decision = denied(`${SIMPLE_CHAT} whoami --json; cat /Users/jay/.secrets/example-credentials`);
    expect(decision.name).toBe("simple-chat");
    expect(JSON.stringify(decision)).not.toContain("secrets");
  });
});

describe("the retired launcher spelling", () => {
  const RETIRED = "/Users/jay/.local/bin/agent-sync";
  const policy: ToolPolicy = {
    mode: "allowlist",
    commands: [{ argv0: RETIRED, sub: ["whoami"], flags: {}, args: [], positionals: 0 }],
    writePaths: [],
    readPaths: [],
  };

  it("refuses it as the program even when a stored policy still names it, and says it is retired", () => {
    const decision = evaluateCommand(policy, `${RETIRED} whoami`);
    if (decision.ok) throw new Error("allowed the retired spelling");
    expect(decision.reason).toContain("agent-sync has been retired: use simple-chat");
  });

  it("refuses a case-variant of it that a case-insensitive volume resolves to the same binary", () => {
    const variantPolicy: ToolPolicy = {
      ...policy,
      commands: [{ argv0: "/Users/jay/.local/bin/Agent-Sync", sub: ["whoami"], flags: {}, args: [], positionals: 0 }],
    };
    const decision = evaluateCommand(variantPolicy, "/Users/jay/.local/bin/Agent-Sync whoami");
    if (decision.ok) throw new Error("allowed a case variant of the retired spelling");
    expect(decision.reason).toContain("retired");
  });

  it("refuses to save a new policy that names it as the program", () => {
    expect(() => sanitizeToolPolicy(policy)).toThrow(/agent-sync has been retired/);
  });

  it("still runs tail on a file that carries the retired name", () => {
    const tailPolicy = sanitizeToolPolicy({
      mode: "allowlist",
      commands: [{ argv0: "/usr/bin/tail", sub: [], flags: {}, args: [], positionals: 1 }],
      writePaths: [],
      readPaths: [],
    });
    const decision = evaluateCommand(tailPolicy!, "/usr/bin/tail /tmp/agent-sync");
    if (!decision.ok) throw new Error(`refused tail on a file named agent-sync: ${decision.reason}`);
  });

  it("still runs rm on the retired launcher itself, so it can be deleted", () => {
    const rmPolicy = sanitizeToolPolicy({
      mode: "allowlist",
      commands: [{ argv0: "/bin/rm", sub: [], flags: {}, args: [], positionals: 1 }],
      writePaths: [],
      readPaths: [],
    });
    const decision = evaluateCommand(rmPolicy!, "/bin/rm /Users/jay/.local/bin/agent-sync");
    if (!decision.ok) throw new Error(`refused rm of the retired launcher: ${decision.reason}`);
  });

  it("saves and runs a policy that pins the retired name as a fixed data word", () => {
    // A fixed word is not always a program:  a policy may pin an operand
    // that carries the retired name.  Save-time and run time both leave
    // data words alone;  only the program word is refused.
    const fixedDataPolicy = sanitizeToolPolicy({
      mode: "allowlist",
      commands: [{ argv0: "/bin/rm", sub: ["/Users/jay/.local/bin/agent-sync"], flags: {}, args: [], positionals: 0 }],
      writePaths: [],
      readPaths: [],
    });
    const decision = evaluateCommand(fixedDataPolicy!, "/bin/rm /Users/jay/.local/bin/agent-sync");
    if (!decision.ok) throw new Error(`refused a fixed data word: ${decision.reason}`);
  });

  it("does not let one entry's words condemn an invocation that matches a sibling entry", () => {
    const mixedPolicy = sanitizeToolPolicy({
      mode: "allowlist",
      commands: [
        { argv0: PYTHON, sub: ["legacy"], flags: {}, args: [], positionals: 0 },
        { argv0: PYTHON, sub: [], flags: {}, args: [], positionals: 2 },
      ],
      writePaths: [],
      readPaths: [],
    });
    const decision = evaluateCommand(mixedPolicy!, `${PYTHON} /data/agent-sync report`);
    if (!decision.ok) throw new Error(`sibling entry poisoned an allowed invocation: ${decision.reason}`);
  });

  it("does not touch a word that only starts with the name", () => {
    const decision = evaluateCommand(policy, "/usr/bin/tail /tmp/agent-sync.log");
    if (decision.ok) throw new Error("allowed an unlisted program");
    expect(decision.reason).not.toContain("retired");
  });
});

describe("evaluateArgv", () => {
  it("applies the same rules to an argv an engine passes as a list", () => {
    expect(evaluateArgv(policy(), [SIMPLE_CHAT, "whoami", "--json"])).toMatchObject({ ok: true });
    expect(evaluateArgv(policy(), [SIMPLE_CHAT, "whoami", "--json", ";", "touch", "PWNED"]).ok).toBe(false);
    expect(evaluateArgv(policy(), ["touch", "PWNED"]).ok).toBe(false);
  });
});

describe("unwrapShellCommand", () => {
  it("unwraps the bash -lc wrapper an engine builds, including the '\"'\"' idiom", () => {
    expect(unwrapShellCommand(`/opt/homebrew/bin/bash -lc '${SIMPLE_CHAT} whoami --json'`)).toEqual({
      command: `${SIMPLE_CHAT} whoami --json`,
    });
    expect(unwrapShellCommand(`/bin/bash -lc '${SIMPLE_CHAT} read --topic '"'"'a b'"'"''`)).toEqual({
      command: `${SIMPLE_CHAT} read --topic 'a b'`,
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
    expect(unwrapShellCommand(`${SIMPLE_CHAT} whoami --json`)).toEqual({ command: `${SIMPLE_CHAT} whoami --json` });
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
    const quoted = inner(`/bin/bash -lc "${SIMPLE_CHAT} read --topic \\"a b\\""`);
    expect(quoted).toBe(`${SIMPLE_CHAT} read --topic "a b"`);
    expect(evaluateCommand(policy(), quoted)).toMatchObject({ ok: true });
    for (const wrapper of [
      `/bin/bash -lc "${SIMPLE_CHAT} read --topic \\"a!b\\""`,
      `/bin/bash -lc "${SIMPLE_CHAT} read --topic \\"a\\\\\\"b\\""`,
      `/bin/bash -lc "${SIMPLE_CHAT} read --topic \\"\\$(touch PWNED)\\""`,
      `/bin/bash -lc "${SIMPLE_CHAT} whoami --json \\\`touch PWNED\\\`"`,
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
    ["a relative program", { mode: "allowlist", commands: [{ argv0: "simple-chat", sub: [] }] }],
    ["a program with ..", { mode: "allowlist", commands: [{ argv0: "/usr/../bin/sh", sub: [] }] }],
    ["a program with a space", { mode: "allowlist", commands: [{ argv0: "/usr/bin/my tool", sub: [] }] }],
    ["a sub word that is a flag", { mode: "allowlist", commands: [{ argv0: "/bin/x", sub: ["-c"] }] }],
    ["a sub word with a metacharacter", { mode: "allowlist", commands: [{ argv0: "/bin/x", sub: ["a;b"] }] }],
    ["a bad flag name", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "json": { value: "none" } } }] }],
    ["an unknown value kind", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "regex" } } }] }],
    ["a relative path flag", { mode: "allowlist", commands: [{ argv0: "/bin/x", flags: { "--a": { value: "path", paths: ["a.md"] } } }] }],
    ["a directory write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/apps/state/"] }],
    ["a relative write path", { mode: "allowlist", commands: [], writePaths: ["state/dm.md"] }],
    ["a glob write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/apps/state/*.md"] }],
    ["a dotfile write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.zshrc"] }],
    ["a write path in a dot directory", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.local/state/x.md"] }],
    ["a credential directory write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/.secrets/zulip"] }],
    ["a LaunchAgents write path", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/Library/LaunchAgents/x.plist"] }],
    ["a LaunchAgents write path with folded case", { mode: "allowlist", commands: [], writePaths: ["/Users/jay/library/launchagents/x.plist"] }],
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
    ["simple-chat --fleet", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--fleet": { value: "none" } } }] }],
    ["simple-chat --to", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--to": { value: "text" } } }] }],
    ["simple-chat --as", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["whoami"], flags: { "--as": { value: "text" } } }] }],
    ["simple-chat --session", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["whoami"], flags: { "--session": { value: "text" } } }] }],
    ["simple-chat --rc", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["whoami"], flags: { "--rc": { value: "text" } } }] }],
    ["an abbreviation of a forbidden simple-chat flag", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--fl": { value: "none" } } }] }],
    ["simple-chat dm without a required --owner", { mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["dm"], flags: { "--owner": { value: "none" } } }] }],
    ["simple-chat named in another letter case, with --as", { mode: "allowlist", commands: [{ argv0: "/Users/jay/.local/bin/Simple-Chat", sub: ["whoami"], flags: { "--as": { value: "text" } } }] }],
    ["simple-chat run by an interpreter, with --to", { mode: "allowlist", commands: [{ argv0: PYTHON, sub: ["/Users/jay/apps/fleet/simple-chat", "post"], flags: { "--to": { value: "text" } } }] }],
    ["simple-chat dm run by an interpreter without a required --owner", { mode: "allowlist", commands: [{ argv0: PYTHON, sub: ["/Users/jay/apps/fleet/simple-chat", "dm"], flags: { "--owner": { value: "none" } } }] }],
  ])("refuses %s", (_label, raw) => {
    expect(() => sanitizeToolPolicy(raw)).toThrow(/Command allowlist/);
  });

  it("names the current CLI when it refuses a policy", () => {
    expect(() =>
      sanitizeToolPolicy({ mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["post"], flags: { "--fleet": { value: "none" } } }] }),
    ).toThrow(/simple-chat/);
    expect(() =>
      sanitizeToolPolicy({ mode: "allowlist", commands: [{ argv0: SIMPLE_CHAT, sub: ["dm"], flags: { "--owner": { value: "none" } } }] }),
    ).toThrow(/simple-chat/);
  });
});

describe("namesChatCli", () => {
  it("names the current CLI in any letter case", () => {
    for (const word of [
      "/Users/jay/.local/bin/simple-chat",
      "/Users/jay/.local/bin/SIMPLE-CHAT",
      "/Users/jay/.local/bin/Simple-Chat",
      "/Users/jay/.local/bin/../bin/simple-chat",
      "/Users/jay/.local/bin/./simple-chat",
      "/Users/jay//.local/bin/simple-chat",
      "/tmp/simple-chat",
    ]) {
      expect(namesChatCli(word), word).toBe(true);
    }
  });

  it("names nothing else", () => {
    for (const word of [
      "/Users/jay/.local/bin/simple-chatter",
      "/Users/jay/.local/bin/simple-chats",
      "/Users/jay/.local/bin/whoami",
      "/Users/jay/.local/bin/simple_chat",
    ]) {
      expect(namesChatCli(word), word).toBe(false);
    }
  });
});
