// The workspace Default Voice picker and the Pronunciations list, rendered.
// Same DOM setup as VoiceSettings.behavior.test.tsx: the node environment
// (the store graph imports node:sqlite) with happy-dom installed first.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

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

const apiMock = vi.hoisted(() => vi.fn());
const dispatchMock = vi.hoisted(() => vi.fn());
const speakMock = vi.hoisted(() => vi.fn(async () => {}));
const storeState = vi.hoisted(() => ({
  config: {
    tts: {
      provider: "minimax" as const,
      configured: true,
      ready: true,
      voice: "jay-wedgeworth-001",
      pronunciations: [
        { term: "SQL", say: "sequel" },
        { term: "cron", say: "kron" },
      ] as Array<{ term: string; say: string }> | undefined,
    },
  },
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: storeState, dispatch: dispatchMock }),
  api: (path: string, init?: RequestInit) => apiMock(path, init),
}));

vi.mock("@/lib/tts", () => ({ speaker: { speak: speakMock } }));

import { DefaultVoicePicker, NO_DEFAULT_VOICE_HELP, PronunciationSettings } from "./WorkspaceVoiceSettings";
import { PERSONAL_VOICE_NOT_DEFAULT } from "../../shared/bot-voice";

const ConfigPutSchema = z.object({
  tts: z.object({
    voice: z.string().optional(),
    pronunciations: z.array(z.object({ term: z.string(), say: z.string() }).strict()).optional(),
  }).strict(),
}).strict();

function putBody(call: unknown[]) {
  const init = call[1] as RequestInit | undefined;
  expect(call[0]).toBe("/api/config");
  expect(init?.method).toBe("PUT");
  return ConfigPutSchema.parse(JSON.parse(String(init?.body)));
}

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
    apiMock.mockReset();
    dispatchMock.mockReset();
    speakMock.mockClear();
    storeState.config.tts.voice = "jay-wedgeworth-001";
    storeState.config.tts.pronunciations = [
      { term: "SQL", say: "sequel" },
      { term: "cron", say: "kron" },
    ];
  });

  const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="Default voice for every bot"]')!;
  const optionTexts = () => [...picker().querySelectorAll("option")].map((o) => o.textContent);

  it("shows the default voice by name, never a Personal Voice, and says why", async () => {
    await mount(createElement(DefaultVoicePicker, { voices: VOICES, loading: false }));
    expect(picker().value).toBe("jay-wedgeworth-001");
    expect(optionTexts()).toEqual(["Jay Wedgeworth 001 — Custom", "Graceful Lady — Standard · Female"]);
    expect(container.textContent).toContain(PERSONAL_VOICE_NOT_DEFAULT);
  });

  it("saves a new default voice through PUT /api/config, id exactly as listed", async () => {
    apiMock.mockResolvedValue({ tts: { voice: "English_Graceful_Lady" } });
    await mount(createElement(DefaultVoicePicker, { voices: VOICES, loading: false }));
    await act(async () => setSelectValue(picker(), "English_Graceful_Lady"));
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(putBody(apiMock.mock.calls[0])).toEqual({ tts: { voice: "English_Graceful_Lady" } });
    expect(dispatchMock).toHaveBeenCalledWith({ type: "configStatus", config: { tts: { voice: "English_Graceful_Lady" } } });
  });

  it("says there is no default voice, and what that means", async () => {
    storeState.config.tts.voice = "";
    await mount(createElement(DefaultVoicePicker, { voices: VOICES, loading: false }));
    expect(picker().value).toBe("");
    expect(optionTexts()[0]).toBe("No default voice");
    expect(container.textContent).toContain(NO_DEFAULT_VOICE_HELP);
    const tryButton = container.querySelector<HTMLButtonElement>('button[aria-label="Pick a default voice first"]');
    expect(tryButton?.disabled).toBe(true);
  });

  it("keeps showing a default the list does not have, by name", async () => {
    storeState.config.tts.voice = "some-old-voice";
    await mount(createElement(DefaultVoicePicker, { voices: VOICES, loading: false }));
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
    apiMock.mockImplementation(async (_path: string, init?: RequestInit) => ({
      tts: { voice: "jay-wedgeworth-001", pronunciations: ConfigPutSchema.parse(JSON.parse(String(init?.body))).tts.pronunciations },
    }));
    await mount(createElement(PronunciationSettings));
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
    expect(putBody(apiMock.mock.calls[0])).toEqual({
      tts: { pronunciations: [{ term: "SQL", say: "sequel" }, { term: "GUI", say: "gooey" }] },
    });
    expect(dispatchMock).toHaveBeenCalled();
  });

  it("refuses a duplicate term before saving, in plain words", async () => {
    await mount(createElement(PronunciationSettings));
    await act(async () => button("Add Term").click());
    await act(async () => setInputValue(rows()[2].term, "sql"));
    await act(async () => setInputValue(rows()[2].say, "S Q L"));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("sql is on the list twice.");
    expect(button("Save Pronunciations").disabled).toBe(true);
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("ignores a blank row instead of refusing it", async () => {
    await mount(createElement(PronunciationSettings));
    await act(async () => button("Add Term").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(button("Save Pronunciations").disabled).toBe(true);
  });

  it("tries a respelling with the workspace default voice", async () => {
    await mount(createElement(PronunciationSettings));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Try SQL"]')!.click());
    expect(speakMock).toHaveBeenCalledWith("sequel", { voiceId: "jay-wedgeworth-001" });
  });

  it("tells an older computer's owner to update instead of showing an empty list", async () => {
    storeState.config.tts.pronunciations = undefined;
    await mount(createElement(PronunciationSettings));
    expect(container.textContent).toContain("Update the bot server on this computer to edit pronunciations.");
    expect(rows()).toHaveLength(0);
  });
});
