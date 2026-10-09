// The workspace Default Voice picker and the Pronunciations list, rendered.
// Same DOM setup as VoiceSettings.behavior.test.tsx: the node environment
// (the store graph imports node:sqlite) with happy-dom installed first.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const happy = require("happy-dom");
  const win = new happy.Window({ url: "http://127.0.0.1:5199/" });
  const install: Array<[string, unknown]> = [
    ["window", win],
    ["document", win.document],
    ["HTMLElement", win.HTMLElement],
    ["HTMLInputElement", win.HTMLInputElement],
    ["HTMLSelectElement", win.HTMLSelectElement],
    ["HTMLButtonElement", win.HTMLButtonElement],
    ["Element", win.Element],
    ["Node", win.Node],
    ["Event", win.Event],
    ["InputEvent", win.InputEvent],
    ["MouseEvent", win.MouseEvent],
    ["MutationObserver", win.MutationObserver],
    ["getComputedStyle", win.getComputedStyle.bind(win)],
    ["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
    ["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ];
  for (const [key, value] of install) Reflect.set(globalThis, key, value);
});

// No module mocking: the sections take their save and speak dependencies
// and the config snapshot as props, so the test hands in its own.
type SaveCall = Parameters<WorkspaceVoiceDeps["saveConfig"]>[0];
const saveCalls: SaveCall[] = [];
const spoken: Array<[string, string]> = [];
const configs: ConfigStatus[] = [];
let saveAnswer: (patch: SaveCall) => Promise<ConfigStatus> = async () => ({}) as ConfigStatus;
const deps: WorkspaceVoiceDeps = {
  saveConfig: (patch) => {
    saveCalls.push(patch);
    return saveAnswer(patch);
  },
  speak: (text, voiceId) => {
    spoken.push([text, voiceId]);
  },
};
const onConfig = (config: ConfigStatus) => {
  configs.push(config);
};

type Tts = NonNullable<ConfigStatus["tts"]>;
const baseTts = (): Tts => ({
  provider: "minimax",
  configured: true,
  ready: true,
  voice: "jay-wedgeworth-001",
  pronunciations: [
    { term: "SQL", say: "sequel" },
    { term: "cron", say: "kron" },
  ],
});

import {
  DefaultVoicePicker,
  NO_DEFAULT_VOICE_HELP,
  PronunciationSettings,
  type WorkspaceVoiceDeps,
} from "./WorkspaceVoiceSettings";
import type { ConfigStatus } from "@/state/store";
import { PERSONAL_VOICE_NOT_DEFAULT } from "../../shared/bot-voice";

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing select value setter");
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const VOICES = [
  { id: "jay-wedgeworth-001", label: "jay-wedgeworth-001", description: "Custom" },
  { id: "English_Graceful_Lady", label: "Graceful Lady", description: "Standard · Female" },
  { id: "personal:Jay", label: "Jay's Personal Voice", description: "Apple Personal Voice" },
];

describe("workspace voice settings", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function mount(element: ReturnType<typeof createElement>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    await flush();
  }

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    saveCalls.splice(0);
    spoken.splice(0);
    configs.splice(0);
    saveAnswer = async () => ({}) as ConfigStatus;
  });

  const picker_ = (tts: Tts) => createElement(DefaultVoicePicker, { tts, voices: VOICES, loading: false, onConfig, deps });
  const list_ = (tts: Tts) => createElement(PronunciationSettings, { tts, onConfig, deps });

  const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="Default voice for every bot"]')!;
  const optionTexts = () => [...picker().querySelectorAll("option")].map((o) => o.textContent);

  it("shows the default voice by name, never a Personal Voice, and says why", async () => {
    await mount(picker_(baseTts()));
    expect(picker().value).toBe("jay-wedgeworth-001");
    expect(optionTexts()).toEqual(["Jay Wedgeworth 001 — Custom", "Graceful Lady — Standard · Female"]);
    expect(container.textContent).toContain(PERSONAL_VOICE_NOT_DEFAULT);
  });

  it("saves a new default voice through PUT /api/config, id exactly as listed", async () => {
    const saved = { tts: { ...baseTts(), voice: "English_Graceful_Lady" } } as ConfigStatus;
    saveAnswer = async () => saved;
    await mount(picker_(baseTts()));
    await act(async () => setSelectValue(picker(), "English_Graceful_Lady"));
    await flush();
    expect(saveCalls).toEqual([{ tts: { voice: "English_Graceful_Lady" } }]);
    expect(configs).toEqual([saved]);
  });

  it("says there is no default voice, and what that means", async () => {
    await mount(picker_({ ...baseTts(), voice: "" }));
    expect(picker().value).toBe("");
    expect(optionTexts()[0]).toBe("No default voice");
    expect(container.textContent).toContain(NO_DEFAULT_VOICE_HELP);
    const tryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Pick a default voice first"]');
    expect(tryButton?.disabled).toBe(true);
  });

  it("keeps showing a default the list does not have, by name", async () => {
    await mount(picker_({ ...baseTts(), voice: "some-old-voice" }));
    expect(picker().value).toBe("some-old-voice");
    expect(optionTexts()[0]).toBe("Some Old Voice");
  });

  const rows = () =>
    [...container.querySelectorAll<HTMLInputElement>('input[aria-label^="Term "]')].map((term, index) => ({
      term,
      say: container.querySelectorAll<HTMLInputElement>('input[aria-label^="Say "]')[index],
    }));
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

  it("lists the pronunciations in two fields, and saves an edited list", async () => {
    saveAnswer = async (patch) => ({
      tts: { ...baseTts(), pronunciations: "pronunciations" in patch.tts ? patch.tts.pronunciations : [] },
    }) as ConfigStatus;
    await mount(list_(baseTts()));
    expect(rows().map((r) => [r.term.value, r.say.value])).toEqual([["SQL", "sequel"], ["cron", "kron"]]);
    expect(container.textContent).toContain("Say It As");
    expect(button("Save Pronunciations").disabled).toBe(true);

    await act(async () => button("Add Term").click());
    const added = rows()[2];
    await act(async () => setInputValue(added.term, " GUI "));
    await act(async () => setInputValue(added.say, "gooey"));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove cron"]')!.click());
    expect(button("Save Pronunciations").disabled).toBe(false);
    await act(async () => button("Save Pronunciations").click());
    await flush();
    expect(saveCalls).toEqual([{ tts: { pronunciations: [{ term: "SQL", say: "sequel" }, { term: "GUI", say: "gooey" }] } }]);
    expect(configs).toHaveLength(1);
  });

  it("refuses a duplicate term before saving, in plain words", async () => {
    await mount(list_(baseTts()));
    await act(async () => button("Add Term").click());
    await act(async () => setInputValue(rows()[2].term, "sql"));
    await act(async () => setInputValue(rows()[2].say, "S Q L"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("sql is on the list twice.");
    expect(button("Save Pronunciations").disabled).toBe(true);
    expect(saveCalls).toEqual([]);
  });

  it("ignores a blank row instead of refusing it", async () => {
    await mount(list_(baseTts()));
    await act(async () => button("Add Term").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Save Pronunciations").disabled).toBe(true);
  });

  it("says what a new row is missing only once focus leaves it, and politely", async () => {
    await mount(list_(baseTts()));
    await act(async () => button("Add Term").click());
    const added = rows()[2];
    // Add Term puts the cursor in the new row's Term field.
    expect(document.activeElement).toBe(added.term);
    await act(async () => setInputValue(added.term, "S"));
    await act(async () => setInputValue(added.term, "SQ"));
    // Typing the first field is not an error: no alert, no hint yet.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    expect(button("Save Pronunciations").disabled).toBe(true);
    // Moving to the row's other field is not leaving the row.
    await act(async () => added.say.focus());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
    // Leaving the row says what it is missing, as a polite status.
    await act(async () => button("Save Pronunciations").focus());
    await act(async () => button("Add Term").focus());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Add how to say SQ.");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps focus in the list when a row is removed", async () => {
    await mount(list_(baseTts()));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove SQL"]')!.click());
    // The next row's Term field.
    expect(document.activeElement).toBe(rows()[0].term);
    expect(rows()[0].term.value).toBe("cron");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Remove cron"]')!.click());
    // With no rows left, Add Term.
    expect(document.activeElement).toBe(button("Add Term"));
  });

  it("tries a respelling with the workspace default voice", async () => {
    await mount(list_(baseTts()));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Try SQL"]')!.click());
    expect(spoken).toEqual([["sequel", "jay-wedgeworth-001"]]);
  });

  it("tells an older computer's owner to update instead of showing an empty list", async () => {
    await mount(list_({ ...baseTts(), pronunciations: undefined }));
    expect(container.textContent).toContain("Update the bot server on this computer to edit pronunciations.");
    expect(rows()).toHaveLength(0);
  });
});
