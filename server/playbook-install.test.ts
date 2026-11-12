import { describe, expect, it } from "vitest";

import { isBotPackage, parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import {
  MAX_INSTALLED_PLAYBOOK_BYTES,
  MAX_INSTALLED_PLAYBOOKS,
  playbooksFromPackage,
  resolvePlaybookInstall,
} from "./playbook-install.ts";
import { renderInstalledPlaybooks, selectInstalledPlaybooks } from "./installed-playbooks.ts";
import type { JsonValue } from "./schema.ts";
import type { InstalledPlaybook } from "./store.ts";

type TestPackageDocument = JsonValue & { package: { agents: Array<{ playbooks: string[] }> } };

/** A minimal valid `botfleet.package` document.  `agentKeys` defaults to every
 *  declared playbook, which is what a package that installs them looks like.
 *  It is a parameter because the package schema caps an agent's references at
 *  40 while allowing 80 declared playbooks, and a document may carry
 *  playbooks its own agent does not use. */
const packageDocument = (playbooks: unknown[], agentKeys?: string[]): TestPackageDocument =>
  // SAFETY: the literal below is built here from plain strings, numbers,
  // booleans and arrays, so it is JsonValue; the intersection only re-opens
  // `package.agents` so a test can edit an agent's playbook references.
  ({
  format: "botfleet.package",
  version: 1,
  package: {
    id: "signal-desk",
    release: "1.0.0",
    name: "Signal Desk",
    tagline: "Find and explain the signal.",
    summary: "A two-bot signal workflow.",
    category: "Research",
    author: { name: "BotFleet" },
    license: "MIT",
    outcomes: ["Produce a concise signal brief."],
    setupMinutes: 4,
    requirements: { apps: [], capabilities: [] },
    agents: [
      {
        key: "scout",
        name: "Package Scout",
        appearance: { color: "cyan" },
        playbooks: agentKeys ?? playbooks.map((playbook) => (playbook as { key: string }).key),
      },
    ],
    playbooks,
  },
}) as unknown as TestPackageDocument;

const signalCheck = {
  key: "signal-check",
  name: "Signal Check",
  summary: "Confirm a source before believing it.",
  triggers: ["release notes", "roadmap"],
  instructions: "Open the primary source and quote it.",
};

describe("playbooksFromPackage", () => {
  it("reads the playbooks out of a JSON package, in package order", () => {
    const second = { ...signalCheck, key: "brief", name: "Brief", triggers: ["brief"] };
    expect(playbooksFromPackage(packageDocument([signalCheck, second])).map((p) => p.key))
      .toEqual(["signal-check", "brief"]);
  });

  it("reads the playbooks out of the portable Markdown blueprint", () => {
    // The same artifact the team library exports, round-tripped through the
    // renderer a client uses for a download.
    const markdown = renderBotPackageMarkdown(parseBotPackage(packageDocument([signalCheck])));
    expect(isBotPackage(markdown)).toBe(true);
    expect(playbooksFromPackage(markdown)).toEqual([signalCheck]);
  });

  it("rejects a document that is not a package rather than installing nothing", () => {
    expect(() => playbooksFromPackage({ format: "something.else" })).toThrow("not a BotFleet package");
    // A package whose playbook references nothing bogus but whose agent names
    // an unknown playbook key is still a bad document.
    const dangling = packageDocument([signalCheck]);
    dangling.package.agents[0].playbooks = ["missing"];
    expect(() => playbooksFromPackage(dangling)).toThrow("unknown playbook");
  });
});

describe("resolvePlaybookInstall", () => {
  it("installs a package's playbooks onto a bot that has none", () => {
    const result = resolvePlaybookInstall({ document: packageDocument([signalCheck]) });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.playbooks).toEqual([signalCheck]);
  });

  it("keeps what the bot already had, in order, and appends what is new", () => {
    const existing: InstalledPlaybook[] = [
      { key: "launch", name: "Launch", summary: "Ship it.", triggers: ["launch"], instructions: "Cut the tag." },
    ];
    const added = { ...signalCheck, key: "brief", name: "Brief", triggers: ["brief"] };
    const result = resolvePlaybookInstall({
      document: packageDocument([signalCheck, added]),
      existing,
    });
    expect(result.ok && result.playbooks.map((p) => p.key)).toEqual(["launch", "signal-check", "brief"]);
    // The caller's array is not mutated: the store hands out the live record.
    expect(existing.map((p) => p.key)).toEqual(["launch"]);
  });

  it("replaces a key that is already installed, in place, rather than duplicating it", () => {
    const existing: InstalledPlaybook[] = [
      { key: "signal-check", name: "Signal Check", summary: "Old text.", triggers: ["roadmap"], instructions: "Old steps." },
      { key: "launch", name: "Launch", summary: "Ship it.", triggers: ["launch"], instructions: "Cut the tag." },
    ];
    const result = resolvePlaybookInstall({ document: packageDocument([signalCheck]), existing });
    expect(result.ok && result.playbooks).toEqual([signalCheck, existing[1]]);
    expect(result.ok && result.installed).toEqual([signalCheck]);
  });

  it("installs only the named keys, in package order", () => {
    const brief = { ...signalCheck, key: "brief", name: "Brief", triggers: ["brief"] };
    const result = resolvePlaybookInstall({
      document: packageDocument([signalCheck, brief]),
      keys: ["brief", "signal-check"],
      existing: [],
    });
    expect(result.ok && result.playbooks.map((p) => p.key)).toEqual(["signal-check", "brief"]);
  });

  it("refuses a key the package does not declare instead of installing nothing", () => {
    expect(resolvePlaybookInstall({ document: packageDocument([signalCheck]), keys: ["missing"] }))
      .toEqual({ ok: false, error: "This package has no playbook: missing" });
    expect(resolvePlaybookInstall({ document: packageDocument([signalCheck]), keys: [] }))
      .toEqual({ ok: false, error: "keys must name at least one playbook" });
    expect(resolvePlaybookInstall({ document: packageDocument([signalCheck]), keys: [""] }))
      .toEqual({ ok: false, error: "keys must be a list of playbook keys" });
  });

  it("refuses a package that declares no playbooks at all", () => {
    expect(resolvePlaybookInstall({ document: packageDocument([]) }))
      .toEqual({ ok: false, error: "This package declares no playbooks to install" });
  });

  it("surfaces the package parser's own error, and never writes on a bad document", () => {
    const result = resolvePlaybookInstall({ document: "not a package" });
    expect(result).toEqual({ ok: false, error: "This is not a BotFleet package" });
  });

  it("bounds the stored list the way the package schema bounds a package", () => {
    // The package schema already caps a package at 80 playbooks, so a single
    // document can never push a bot past the ceiling.  What only this check
    // can catch is a bot already AT the ceiling installing one more key.
    const atCeiling = Array.from({ length: MAX_INSTALLED_PLAYBOOKS }, (_, i) => ({
      ...signalCheck,
      key: `p${i}`,
      triggers: ["roadmap"],
    })) as InstalledPlaybook[];
    const over = resolvePlaybookInstall({
      document: packageDocument([{ ...signalCheck, key: "one-more", triggers: ["roadmap"] }]),
      existing: atCeiling,
    });
    expect(over).toEqual({
      ok: false,
      error: `A bot may hold at most ${MAX_INSTALLED_PLAYBOOKS} playbooks, this would be ${MAX_INSTALLED_PLAYBOOKS + 1}`,
    });
    // Replacing a key the bot already holds is not growth, so it still lands.
    const replace = resolvePlaybookInstall({
      document: packageDocument([{ ...signalCheck, key: "p0", triggers: ["roadmap"] }]),
      existing: atCeiling,
    });
    expect(replace.ok).toBe(true);
    expect(replace.ok && replace.playbooks).toHaveLength(MAX_INSTALLED_PLAYBOOKS);
    // The 1 MB ceiling is bot-package.ts's own Markdown guard, reused so the
    // two documents answer "how big" the same way.
    expect(MAX_INSTALLED_PLAYBOOK_BYTES).toBe(1_000_000);
  });

  it("keeps a 24k-instruction playbook installable, and refuses a list past the 1 MB ceiling", () => {
    const big = { ...signalCheck, instructions: "x".repeat(24_000) };
    const result = resolvePlaybookInstall({ document: packageDocument([big]) });
    expect(result.ok).toBe(true);
    expect(result.ok && result.playbooks[0].instructions).toHaveLength(24_000);

    // Under the count ceiling, over the byte ceiling: 50 x 24k is ~1.2 MB, and
    // bot-package.ts's own Markdown guard is 1 MB, so the same question has the
    // same answer whichever side of the boundary it arrives on.
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...big, key: `p${i}` }));
    expect(resolvePlaybookInstall({ document: packageDocument(fifty, ["p0"]) }))
      .toEqual({ ok: false, error: "The installed playbooks are too large" });
  });

  it("produces playbooks the existing selector and renderer mount", () => {
    // The point of the whole path: after an install, trigger matching and the
    // prompt block work with no further plumbing.
    const result = resolvePlaybookInstall({ document: packageDocument([signalCheck]) });
    expect(result.ok).toBe(true);
    const installed = result.ok ? result.playbooks : [];
    expect(selectInstalledPlaybooks("summarize the release notes", installed).map((p) => p.key))
      .toEqual(["signal-check"]);
    expect(selectInstalledPlaybooks("what is the weather", installed)).toEqual([]);
    expect(renderInstalledPlaybooks(installed)).toContain("Open the primary source and quote it.");
  });
});
