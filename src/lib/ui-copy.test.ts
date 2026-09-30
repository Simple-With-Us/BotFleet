// Copy rules the UI is expected to hold to, checked against the source rather
// than a rendered screen: both are one-word-at-a-time regressions that no
// behavioural test would ever notice.
//
//  1. One nomenclature.  A user of this app has Bots, never "agents" — the
//     word only survives where it names something outside the app's own
//     vocabulary (a browser user agent, an ssh-agent, a driver kind, a host
//     name, another vendor's product).
//  2. Title Case for the things a user clicks or that name a region.  This
//     locks the surfaces that had drifted, so a later edit that reintroduces
//     "Working folder" next to "Working Folder" fails here instead of
//     shipping.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

const FILES = sourceFiles(SRC).map((path) => ({
  path,
  rel: path.slice(SRC.length + 1).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));

/** JSX text nodes plus the three attributes that reach a person: a tooltip,
 * a screen-reader name, and the grey text inside an empty field. */
function userFacingStrings(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:title|aria-label|placeholder)="([^"]+)"/g)) found.push(match[1]!);
  for (const match of text.matchAll(/>\s*([A-Za-z][^<>{}\n]{1,120}?)\s*</g)) found.push(match[1]!);
  return found;
}

/** Where "agent" is still the accurate word: it is not the app's concept. */
const AGENT_ALLOWED = [
  "agents.botfleet.app", // a host name the user types back in
  "agent-memory", // an example Qdrant collection id, not a label
  "fleet-agents", // the live recall collection id, not a product noun
  "SSH config and agent", // ssh-agent, a thing the operating system runs
];

describe("one nomenclature: Bot, never Agent", () => {
  it("keeps 'agent' out of every user-facing string", () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const value of userFacingStrings(text)) {
        if (!/\bagents?\b/i.test(value)) continue;
        if (AGENT_ALLOWED.some((allowed) => value.includes(allowed))) continue;
        offenders.push(`${path.slice(SRC.length + 1).replaceAll("\\", "/")}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Title Case for controls and headings", () => {
  // Each entry is a label a user clicks or that names a region, with the
  // sentence-case spelling it must never drift back to.
  const LABELS: Array<[file: string, wrong: string, right: string]> = [
    ["components/ChatView.tsx", ">Working folder<", ">Working Folder<"],
    ["components/ChatView.tsx", ">Session usage<", ">Session Usage<"],
    ["components/ChatView.tsx", "Bot's computer", "Bot's Computer"],
    ["components/ChatView.tsx", "Agent profile & settings", "Bot Profile &amp; Settings"],
    ["components/SettingsPanel.tsx", ">Agent profile<", ">Bot Profile<"],
    ["components/SettingsPanel.tsx", ">Working folder<", ">Working Folder<"],
    ["components/SettingsPanel.tsx", ">Auto mode<", ">Auto Mode<"],
    ["components/QdrantRagConnection.tsx", "Agent RAG", "Bot RAG &amp; Shared Memory"],
    ["components/TeamMapPage.tsx", ">Agent handoffs<", ">Bot Handoffs<"],
    ["components/RoutinesPage.tsx", "Tasks &amp; routines", "Tasks &amp; Routines"],
    ["components/Sidebar.tsx", ">Archived bots<", ">Archived Bots<"],
    ["components/SettingsModal.tsx", 'title="Usage analytics"', 'title="Usage Analytics"'],
    ["components/SettingsNav.tsx", 'label: "Remote access"', 'label: "Remote"'],
    ["components/UsageSection.tsx", "Test connection", "Test Connection"],
    ["components/FleetModelsSection.tsx", "Set default", "Set Default"],
    ["components/FleetModelsSection.tsx", "Add fallback", "Add Fallback"],
    ["components/FleetModelsSection.tsx", "Apply to all bots", "Apply to All Bots"],
  ];

  for (const [file, wrong, right] of LABELS) {
    it(`${file} uses "${right}"`, () => {
      const source = FILES.find((entry) => entry.rel === file || entry.rel.endsWith(`/${file}`));
      expect(source, `${file} is missing`).toBeDefined();
      expect(source!.text).toContain(right);
      expect(source!.text).not.toContain(wrong);
    });
  }
});

describe("Settings Models layout", () => {
  it("grows the Settings dialog so the capability table and fleet rows fit with user resizability", () => {
    const settings = FILES.find((entry) => entry.rel === "components/SettingsModal.tsx");
    expect(settings, "SettingsModal.tsx is missing").toBeDefined();
    expect(settings!.text).toContain("DEFAULT_SETTINGS_MODAL_WIDTH_PX = 1292");
    expect(settings!.text).toContain("DEFAULT_SETTINGS_MODAL_HEIGHT_PX = 976");
    expect(settings!.text).toContain("saveSettingsModalSize");
    expect(settings!.text).not.toContain("h-[min(720px,calc(100dvh-3rem))]");
    expect(settings!.text).not.toContain("h-[560px]");
    expect(settings!.text).not.toContain("max-w-[860px]");
  });

  it("wraps fleet model pills so Primary, fallbacks, and Add Fallback do not overlap", () => {
    const models = FILES.find((entry) => entry.rel === "components/FleetModelsSection.tsx");
    const picker = FILES.find((entry) => entry.rel === "components/ModelPicker.tsx");
    expect(models, "FleetModelsSection.tsx is missing").toBeDefined();
    expect(picker, "ModelPicker.tsx is missing").toBeDefined();
    expect(models!.text).toContain("flex-wrap");
    expect(models!.text).toContain("Add Fallback");
    expect(models!.text).toContain("flex-[1_1_16rem]");
    expect(models!.text).not.toContain("grid-cols-[minmax(0,1.1fr)");
    expect(models!.text).not.toContain("&nbsp;");
    expect(picker!.text).toContain('contained && !label && "w-full min-w-0 justify-between"');
    // picking a new primary keeps the bot's fallback chain: the picker builds the
    // selection with pickedSelection, which builds on selectionForPick, which
    // copies the fallbacks across
    const pick = FILES.find((entry) => entry.rel === "lib/model-pick.ts");
    expect(pick, "model-pick.ts is missing").toBeDefined();
    expect(picker!.text).toContain("pickedSelection(selection, instance, model, latest)");
    expect(pick!.text).toContain("...selectionForPick(current, instance, model)");
    expect(pick!.text).toContain("if (current.fallbacks?.length) next.fallbacks = current.fallbacks");
  });

  it("stacks iOS primary and fallback pickers on their own rows", () => {
    const swift = readFileSync(join(SRC, "../ios/App/AgentProfileView.swift"), "utf8");
    expect(swift).toContain('Section("Primary Model")');
    expect(swift).toContain('Section("Fallback \\(index + 1)")');
    expect(swift).toContain(".pickerStyle(.navigationLink)");
    expect(swift).toContain('Button("Add Fallback"');
    expect(swift).not.toContain("Add fallback model");
    expect(swift).not.toContain("VStack(alignment: .leading, spacing: 6)");
  });
});

describe("Bot Chats sidebar section appears once", () => {
  it("Sidebar.tsx renders BOT_CHATS_SECTION SectionDivider exactly once", () => {
    const source = FILES.find((entry) => entry.rel === "components/Sidebar.tsx" || entry.rel.endsWith("/components/Sidebar.tsx"));
    expect(source, "components/Sidebar.tsx is missing").toBeDefined();
    // name={BOT_CHATS_SECTION} is the SectionDivider prop — duplicate section = duplicate divider.
    const matches = source!.text.match(/name=\{BOT_CHATS_SECTION\}/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
