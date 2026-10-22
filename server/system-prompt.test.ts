// The builder is the one place the system prompt is put together for the
// direct lane and the room lane.  It is pure: it orders the parts it is
// handed, drops the empty ones, measures each section, and splits the
// prompt at the volatile boundary — without changing a byte of the joined
// string the lanes used to concatenate by hand.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { installedPlaybookInstructions } from "./installed-playbooks.ts";
import { renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";
import type { InstalledPlaybook } from "./store.ts";
import { buildSystemPrompt, isVolatileSection, VOLATILE_SECTIONS, volatileDigest, type PromptPart } from "./system-prompt.ts";

/** The direct lane's pre-split concatenation, kept here verbatim in shape so
 * the builder is pinned to the bytes the lane emitted before the split. */
interface DirectLaneFixture {
  persona: string;
  computer: string;
  composio: string;
  recall: string;
  coordination: string;
  credential: string;
  routine: string;
  sectionContext: string;
  fileTools: boolean;
  memory: string;
  skills: string;
  skillInstructions: string;
  playbooks: string;
  automation: string;
  tagged: Array<{ name: string; id: string }>;
}

function oldDirectLanePrompt(f: DirectLaneFixture): string {
  return (
    f.persona +
    f.computer +
    f.composio +
    f.recall +
    (f.coordination ? ` ${f.coordination}` : "") +
    f.credential +
    f.routine +
    f.sectionContext +
    (f.fileTools ? f.memory + f.skills : "") +
    f.skillInstructions +
    f.playbooks +
    f.automation +
    (f.tagged.length
      ? ` The user tagged ${f.tagged.map((t) => `@${t.name} (ask_bot bot_id ${t.id})`).join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
      : "")
  );
}

function directLaneParts(f: DirectLaneFixture): PromptPart[] {
  return [
    { id: "persona", label: "Identity", text: f.persona },
    { id: "computer", label: "Computer", text: f.computer },
    { id: "composio", label: "Connected apps", text: f.composio },
    { id: "recall", label: "Recall", text: f.recall },
    { id: "coordination", label: "Team", text: f.coordination ? ` ${f.coordination}` : "" },
    { id: "credential", label: "Credentials", text: f.credential },
    { id: "routine", label: "Routines", text: f.routine },
    { id: "section-context", label: "Section context", text: f.sectionContext },
    { id: "memory", label: "Memory", text: f.fileTools ? f.memory : "" },
    { id: "skills", label: "Skills index", text: f.fileTools ? f.skills : "" },
    { id: "skill-instructions", label: "Skill instructions", text: f.skillInstructions },
    { id: "playbooks", label: "Playbooks", text: f.playbooks },
    { id: "automation", label: "Automation source", text: f.automation },
    {
      id: "mentions",
      label: "Mentions",
      text: f.tagged.length
        ? ` The user tagged ${f.tagged.map((t) => `@${t.name} (ask_bot bot_id ${t.id})`).join(" and ")} in their message — bring them in with ask_bot and fold their reply into your answer.`
        : "",
    },
  ];
}

const FULL: DirectLaneFixture = {
  persona: "You are BF-Kiwi (display: Kiwi), a bot in BotFleet. Role: Analyst.",
  computer: " You can act on the user's computer through the computer tools.",
  composio: " The user's connected apps are reachable through the composio tools.",
  recall: " You share a memory corpus with the rest of the fleet.",
  coordination: "You are the Chief of Staff for the Work section.\nCurrent Work section team:\n- Quill — Writer",
  credential: " Request credentials with request_credential.",
  routine: " Propose routines with propose_routine.",
  sectionContext: "\n\nShared context for the \"Work\" section follows.\n\n--- BEGIN SHARED SECTION CONTEXT (12 bytes) ---\nships weekly\n--- END SHARED SECTION CONTEXT ---",
  fileTools: true,
  memory: " Your private long-term memory file is \"/w/MEMORY.md\".\n\nYour memory (MEMORY.md):\n- likes tea",
  skills: "\n\nSkills available to you:\n- pdf: read PDFs",
  skillInstructions: "\n\n<botfleet-skill id=\"phone\" version=\"1\">\nUse phone_* tools.\n</botfleet-skill>",
  playbooks: "\n<installed_package_playbooks>\nreview steps\n</installed_package_playbooks>",
  automation: " This task was triggered by an authenticated external webhook.",
  tagged: [{ name: "Quill", id: "b2" }, { name: "Patch", id: "b3" }],
};

describe("buildSystemPrompt", () => {
  const fixtures: Array<[string, DirectLaneFixture]> = [
    ["everything present", FULL],
    ["no file tools, so no memory or skills index", { ...FULL, fileTools: false }],
    ["no mentions", { ...FULL, tagged: [] }],
    ["no chief roster, no section context, no automation", { ...FULL, coordination: "", sectionContext: "", automation: "" }],
    ["bare persona", { ...FULL, computer: "", composio: "", recall: "", coordination: "", credential: "", routine: "", sectionContext: "", fileTools: false, skillInstructions: "", playbooks: "", automation: "", tagged: [] }],
  ];

  it.each(fixtures)("joins the direct lane's parts to the bytes the lane concatenated before the split: %s", (_name, fixture) => {
    const built = buildSystemPrompt(directLaneParts(fixture));
    expect(built.text).toBe(oldDirectLanePrompt(fixture));
  });

  it("joins the room lane's parts to the bytes the lane concatenated before the split", () => {
    const system = ["You are BF-Kiwi, a bot in the room \"Ops\" in BotFleet.", "Room members: @Kiwi, @Quill, and Jay (the human)."].join("\n");
    const computer = " You can act on the computer.";
    const recall = " You share a memory corpus.";
    const memory = " Your memory (MEMORY.md):\n- likes tea ";
    const skills = "\n\nSkills available to you:\n- pdf";
    const skillInstructions = "\n\n<botfleet-skill id=\"pdf\" version=\"1\">\nread it\n</botfleet-skill>";
    const playbooks = "";
    const old = system + computer + recall + "" + `\n${memory.trim()}${skills}` + skillInstructions + playbooks;
    const built = buildSystemPrompt([
      { id: "persona", label: "Identity", text: system },
      { id: "computer", label: "Computer", text: computer },
      { id: "recall", label: "Recall", text: recall },
      { id: "section-context", label: "Section context", text: "" },
      { id: "memory", label: "Memory", text: `\n${memory.trim()}` },
      { id: "skills", label: "Skills index", text: skills },
      { id: "skill-instructions", label: "Skill instructions", text: skillInstructions },
      { id: "playbooks", label: "Playbooks", text: playbooks },
    ]);
    expect(built.text).toBe(old);
    expect(built.stable + built.volatile).not.toBe(built.text);
    expect(built.volatile).toBe(`\n${memory.trim()}` + skillInstructions);
  });

  it("reports the per-turn sections apart from the stable half, in order", () => {
    const built = buildSystemPrompt(directLaneParts(FULL));
    const mentions = directLaneParts(FULL).find((part) => part.id === "mentions")!.text;

    expect(built.volatile).toBe(FULL.memory + FULL.skillInstructions + FULL.playbooks + FULL.automation + mentions);
    expect(built.stable).toBe(
      FULL.persona + FULL.computer + FULL.composio + FULL.recall + ` ${FULL.coordination}` + FULL.credential + FULL.routine +
        FULL.sectionContext + FULL.skills,
    );
    // the roster and the status capsule are byte-stable (PR #617) and stay
    // on the half a warm CLI process is keyed on
    expect(built.stable).toContain("Chief of Staff");
    expect(built.stable).not.toContain("likes tea");
    expect(built.stable).not.toContain("The user tagged");
    expect(built.stable).not.toContain("botfleet-skill");
    expect(built.stable).not.toContain("installed_package_playbooks");
    expect(built.sections.filter((section) => section.volatile).map((section) => section.id)).toEqual([
      "memory",
      "skill-instructions",
      "playbooks",
      "automation",
      "mentions",
    ]);
  });

  it("keeps the stable half byte-identical across messages with different skill and playbook trigger terms", () => {
    // Real selection, as both lanes run it: skills and playbooks are chosen
    // from the text of the message being sent, so two turns of one live
    // session can mount different ones.
    const skill = (id: string, term: string): BundledSkill => ({
      manifest: { id, name: id, version: "1.0.0", description: id, defaultEnabled: true, triggerTerms: [term], requiredCapabilities: [] },
      instructions: `Use the ${id} steps.`,
      directory: `/skills/${id}`,
    });
    const skills = [skill("pdf", "pdf"), skill("spreadsheet", "spreadsheet")];
    const playbooks: InstalledPlaybook[] = [
      { key: "review", name: "Review", summary: "Review steps", triggers: ["code review"], instructions: "Read the diff first." },
    ];
    const turn = (message: string, automation = "") =>
      buildSystemPrompt(directLaneParts({
        ...FULL,
        skillInstructions: renderSkillInstructions(selectBundledSkills(message, [], skills)),
        playbooks: installedPlaybookInstructions(message, playbooks),
        automation,
        tagged: [],
      }));

    const plain = turn("How was your weekend?");
    const pdf = turn("Summarize the attached pdf");
    const review = turn("Do a code review of the spreadsheet export");
    const webhook = turn("New lead arrived", " This task was triggered by an authenticated external webhook.");

    expect(pdf.volatile).toContain("botfleet-skill id=\"pdf\"");
    expect(review.volatile).toContain("botfleet-skill id=\"spreadsheet\"");
    expect(review.volatile).toContain("installed_package_playbooks");
    expect(webhook.volatile).toContain("authenticated external webhook");
    for (const later of [pdf, review, webhook]) {
      expect(later.stable).toBe(plain.stable);
      expect(later.volatileDigest).not.toBe(plain.volatileDigest);
    }
  });

  it("keeps the stable half byte-identical across a memory write and a mention", () => {
    const before = buildSystemPrompt(directLaneParts(FULL));
    const after = buildSystemPrompt(directLaneParts({
      ...FULL,
      memory: FULL.memory + "\n- moved to Toronto",
      tagged: [],
    }));
    expect(after.stable).toBe(before.stable);
    expect(after.volatile).not.toBe(before.volatile);
    expect(after.volatileDigest).not.toBe(before.volatileDigest);
  });

  it("digests the volatile half with sha256 and books the bytes of each half", () => {
    const built = buildSystemPrompt([
      { id: "persona", label: "Identity", text: "Kiwi" },
      { id: "memory", label: "Memory", text: " thé" },
    ]);
    expect(built.volatileDigest).toBe(createHash("sha256").update(" thé").digest("hex"));
    expect(volatileDigest("")).toBe(createHash("sha256").update("").digest("hex"));
    expect(built.bytes).toEqual({ stable: 4, volatile: Buffer.byteLength(" thé", "utf8") });
    expect(built.sections.map((section) => section.bytes)).toEqual([4, Buffer.byteLength(" thé", "utf8")]);
  });

  it("has an empty volatile half when nothing mid-conversation is present", () => {
    const built = buildSystemPrompt([{ id: "persona", label: "Identity", text: "Kiwi." }, { id: "recall", label: "Recall", text: " Search." }]);
    expect(built.volatile).toBe("");
    expect(built.stable).toBe(built.text);
    expect(built.bytes.volatile).toBe(0);
  });

  it("drops empty parts and lets a part force the volatile half", () => {
    const built = buildSystemPrompt([
      { id: "persona", label: "Identity", text: "Kiwi." },
      { id: "plan", label: "Surface", text: "" },
      { id: "snapshot", label: "Live snapshot", text: " now: 20:48", volatile: true },
    ]);
    expect(built.sections.map((section) => section.id)).toEqual(["persona", "snapshot"]);
    expect(built.stable).toBe("Kiwi.");
    expect(built.volatile).toBe(" now: 20:48");
    expect(isVolatileSection({ id: "snapshot", volatile: true })).toBe(true);
    expect(isVolatileSection({ id: "skills" })).toBe(false);
    for (const id of ["memory", "mentions", "outstanding", "recent", "skill-instructions", "playbooks", "automation"]) {
      expect(VOLATILE_SECTIONS.has(id)).toBe(true);
      expect(isVolatileSection({ id })).toBe(true);
    }
  });
});
