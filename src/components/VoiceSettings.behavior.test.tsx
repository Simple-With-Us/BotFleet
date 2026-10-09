// Client render of the voice card.  Static markup cannot show a refusal that
// only exists after commitVoice runs, or a gate that changes while an add
// request is still in flight.  The suite stays on the node environment (the
// store graph imports node:sqlite) and installs a DOM before React loads.

import { createElement, useEffect, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.hoisted(() => {
  const happy = require("happy-dom");
  const win = new happy.Window({ url: "http://127.0.0.1:5199/" });
  // Node's DOM lib and happy-dom's classes are different types.  Reflect.set
  // installs the runtime globals React reads without claiming they are the
  // lib.dom constructors.
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

const baseTts = {
  provider: "minimax",
  configured: true,
  ready: true,
  voice: "standard-default",
};

// The POST body the renderer sends to /api/tts/custom-voice.  JSON.parse
// returns any, so the test mock would silently accept out-of-contract
// payloads.  Strict Zod parsing forces the fixture to throw on malformed
// bodies instead of hiding the bug in a typed annotation.
const CustomVoiceRequestBodySchema = z
  .object({
    voiceId: z.string().optional(),
    label: z.string().optional(),
  })
  .strict();

function parseCustomVoiceRequestBody(init: RequestInit | undefined): { voiceId?: string; label?: string } {
  return CustomVoiceRequestBodySchema.parse(JSON.parse(String(init?.body)));
}

const apiMock = vi.hoisted(() => vi.fn());

const capState = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: {
    personalVoice: boolean;
    ready: boolean;
    reasonCode: string | undefined;
  } = {
    personalVoice: false,
    ready: true,
    reasonCode: "requires-macos-14",
  };
  return {
    listeners,
    state,
    notify() {
      for (const listener of listeners) listener();
    },
    snapshot() {
      return {
        host: { platform: "darwin", label: "macOS", session: "desktop", packaged: true },
        windowChrome: "mac-inset",
        screenPreview: { available: false, interaction: "none" },
        dictation: {
          available: true,
          engine: "apple-speech",
          onDevice: true,
          personalVoice: state.personalVoice,
          reasonCode: state.reasonCode,
        },
        localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
      };
    },
  };
});

vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { config: { tts: baseTts } },
    dispatch: vi.fn(),
  }),
  api: (path: string, init?: RequestInit) => apiMock(path, init),
}));

vi.mock("./DesktopCapabilities", () => {
  const react = require("react");
  return {
    useDesktopCapabilities: () => {
      const [, bump] = react.useState(0);
      react.useEffect(() => {
        const listener = () => bump((n: number) => n + 1);
        capState.listeners.add(listener);
        return () => {
          capState.listeners.delete(listener);
        };
      }, []);
      return { capabilities: capState.snapshot(), ready: capState.state.ready };
    },
  };
});

import {
  DEVICE_VOICES_NEED_UPDATE,
  PERSONAL_VOICE_LIST_TIMEOUT_MS,
  PERSONAL_VOICE_NOT_ON_MAC,
  VoiceSettings,
  type VoiceSettingsPatch,
} from "./VoiceSettings";
import { applyBotPatch } from "@/state/bot-patch-queue";
import type { Bot } from "@/state/store";

const MACOS_14 = "Personal Voices need macOS 14 or later, or an iPhone";
const OTHER_COMPUTER = "Personal Voice is not available on this computer";

/** `voices` defaults to null, as a current harness sends it.  Pass
 * LEGACY_HARNESS for a harness that predates per-device voices. */
const LEGACY_HARNESS = Symbol("legacy harness");
function sampleBot(voice?: string, voices: Bot["voices"] | typeof LEGACY_HARNESS = null): Bot {
  if (voices === LEGACY_HARNESS) {
    return {
      id: "bot-1",
      name: "Assistant",
      threadId: "t1",
      title: "",
      description: "",
      notifications: false,
      color: "blue",
      unread: false,
      modelSelection: { instanceId: "fixture", model: "default" },
      messages: [],
      voice,
    };
  }
  return {
    id: "bot-1",
    name: "Assistant",
    threadId: "t1",
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    modelSelection: { instanceId: "fixture", model: "default" },
    messages: [],
    voice,
    voices,
  };
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

describe("VoiceSettings rendered voice commit", () => {
  let root: Root;
  let container: HTMLDivElement;
  const patches: VoiceSettingsPatch[] = [];
  // The bot the next mount starts from.  Patches fold in exactly as the
  // store folds them (applyBotPatch), so a device the patch does not name
  // keeps its value.
  let startingBot: Bot = sampleBot("");

  function Harness() {
    const [bot, setBot] = useState<Bot>(startingBot);
    useEffect(() => {
      patches.splice(0, patches.length);
    }, []);
    return createElement(VoiceSettings, {
      bot,
      onPatch: (patch) => {
        patches.push(patch);
        setBot((current) => applyBotPatch(current, patch));
      },
    });
  }

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    capState.state.personalVoice = false;
    capState.state.ready = true;
    capState.state.reasonCode = "requires-macos-14";
    capState.listeners.clear();
    apiMock.mockReset();
    patches.splice(0, patches.length);
    startingBot = sampleBot("");
    Reflect.deleteProperty(window, "ogb");
  });

  async function mount() {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") {
        return {
          voices: [
            { id: "personal:jay", label: "Jay Personal", description: "Custom" },
            { id: "custom-1", label: "Mine", description: "Custom" },
          ],
        };
      }
      if (path === "/api/tts/custom-voice" && init?.method === "POST") {
        const body = parseCustomVoiceRequestBody(init);
        const voiceId = body.voiceId ?? "";
        return { ok: true, voice: { id: voiceId, label: body.label || voiceId } };
      }
      if (path.startsWith("/api/tts/custom-voice/") && init?.method === "DELETE") {
        return { ok: true };
      }
      return {};
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
    });
    await flush();
    await flush();
  }

  /** The Mac picker: the first select on the card. */
  function select() {
    const found = container.querySelector("select");
    if (!found) throw new Error("missing voice select");
    return found;
  }

  function iphoneSelect() {
    const found = container.querySelector<HTMLSelectElement>('select[aria-label="Assistant\'s voice on iPhone"]');
    if (!found) throw new Error("missing iPhone voice select");
    return found;
  }

  const macPatch = (patch: VoiceSettingsPatch) => patch.voices?.mac;

  function alerts() {
    return [...container.querySelectorAll("[role=alert]")].map((node) => node.textContent ?? "");
  }

  it("keeps the picker on the default and shows the denial when a personal id is refused", async () => {
    await mount();
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    const label = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice Display Name"]');
    if (!id || !label) throw new Error("missing custom voice fields");
    await act(async () => {
      setInputValue(id, "personal:fixture-voice");
      setInputValue(label, "Jay");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    expect(select().value).toBe("");
    expect(patches.some((patch) => macPatch(patch) === "personal:fixture-voice")).toBe(false);
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);
    expect(container.textContent).not.toContain("Apple Personal Voice: fixture-voice");
    expect(id.value).toBe("personal:fixture-voice");
    expect(label.value).toBe("Jay");
    expect(container.textContent).toContain("Add Voice Identifier");
  });

  it("commits a Personal Voice that becomes allowed while the add request is in flight", async () => {
    let release: (value: { ok: boolean; voice: { id: string; label: string } }) => void = () => {};
    const pending = new Promise<{ ok: boolean; voice: { id: string; label: string } }>((resolve) => {
      release = resolve;
    });
    await mount();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") return { voices: [] };
      if (path === "/api/tts/custom-voice" && init?.method === "POST") return pending;
      return {};
    });
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, "personal:late-voice");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    capState.state.personalVoice = true;
    capState.state.reasonCode = undefined;
    await act(async () => {
      capState.notify();
    });
    await act(async () => {
      release({ ok: true, voice: { id: "personal:late-voice", label: "Late" } });
    });
    await flush();
    await flush();

    expect(patches.some((patch) => macPatch(patch) === "personal:late-voice")).toBe(true);
    expect(select().value).toBe("personal:late-voice");
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(false);
  });

  it("clears a denial after the reason code changes when a non-personal voice is saved", async () => {
    await mount();
    await act(async () => {
      setSelectValue(select(), "personal:jay");
    });
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);

    capState.state.reasonCode = "unsupported-platform";
    await act(async () => {
      capState.notify();
    });
    // The stored sentence is not the gate.  The alert follows the reason code.
    expect(alerts().some((text) => text.includes("Personal Voices play on-device on a Mac or iPhone"))).toBe(true);
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(false);

    capState.state.reasonCode = undefined;
    await act(async () => {
      capState.notify();
    });
    expect(alerts().some((text) => text.includes(OTHER_COMPUTER))).toBe(true);

    await act(async () => {
      setSelectValue(select(), "custom-1");
    });
    expect(select().value).toBe("custom-1");
    expect(alerts().some((text) => text.includes(OTHER_COMPUTER) || text.includes(MACOS_14))).toBe(false);
    expect(patches.some((patch) => macPatch(patch) === "custom-1")).toBe(true);
  });

  it("clears the denial when the custom voice is deleted", async () => {
    await mount();
    await act(async () => {
      setSelectValue(select(), "personal:jay");
    });
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);
    const remove = container.querySelector<HTMLButtonElement>('button[title="Remove Mine from list"]');
    if (!remove) throw new Error("missing delete");
    await act(async () => {
      remove.click();
    });
    await flush();
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(false);
  });

  it("tells the user when a personal id is added before capabilities are ready", async () => {
    capState.state.ready = false;
    capState.state.personalVoice = false;
    await mount();
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, "personal:early-voice");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    expect(select().value).toBe("");
    expect(patches.some((patch) => macPatch(patch) === "personal:early-voice")).toBe(false);
    expect(alerts().some((text) => text.includes("Checking Personal Voice availability"))).toBe(true);
    expect(id.value).toBe("personal:early-voice");
    expect(container.textContent).toContain("Add Voice Identifier");
    // Unresolved gate: the row may be selected once capabilities arrive, so
    // the refusal must not run a compensating DELETE while the user still
    // sees "Checking Personal Voice availability".
    const deleted = apiMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleted).toHaveLength(0);
  });

  it("clears the denial banner when the Personal Voice gate opens", async () => {
    await mount();
    await act(async () => {
      setSelectValue(select(), "personal:jay");
    });
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);

    capState.state.personalVoice = true;
    capState.state.reasonCode = undefined;
    await act(async () => {
      capState.notify();
    });
    await flush();

    expect(alerts().some((text) => text.includes(MACOS_14) || text.includes(OTHER_COMPUTER))).toBe(false);
    expect(select().value).toBe("");
  });

  it("deletes a refused personal id so the picker does not list it", async () => {
    const stored = new Map<string, { id: string; label: string; description: string }>();
    await mount();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") {
        return { voices: [...stored.values()] };
      }
      if (path === "/api/tts/custom-voice" && init?.method === "POST") {
        const body = parseCustomVoiceRequestBody(init);
        const voiceId = body.voiceId ?? "";
        const voice = { id: voiceId, label: body.label || voiceId, description: "Custom" };
        stored.set(voiceId, voice);
        return { ok: true, voice };
      }
      if (path.startsWith("/api/tts/custom-voice/") && init?.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/tts/custom-voice/".length));
        stored.delete(id);
        return { ok: true };
      }
      return {};
    });
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, "personal:fixture-voice");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    const deleted = apiMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleted.map((call) => String(call[0]))).toContain("/api/tts/custom-voice/personal%3Afixture-voice");
    expect([...select().options].some((option) => option.value === "personal:fixture-voice")).toBe(false);
    expect(select().value).toBe("");
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);
    expect(id.value).toBe("personal:fixture-voice");
  });

  it("does not delete a personal id that was already in the voices list on a closed gate", async () => {
    // The id is already in `voices` before the POST.  addCustomVoice upserts,
    // so the POST is a no-op, and a refusal cleanup must not silently
    // destroy the pre-existing row.
    const preExistingId = "personal:preexisting";
    await mount();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") {
        return {
          voices: [
            { id: preExistingId, label: "Pre-existing Personal", description: "Custom" },
          ],
        };
      }
      if (path === "/api/tts/custom-voice" && init?.method === "POST") {
        const body = parseCustomVoiceRequestBody(init);
        const voiceId = body.voiceId ?? "";
        return { ok: true, voice: { id: voiceId, label: body.label || voiceId } };
      }
      if (path.startsWith("/api/tts/custom-voice/") && init?.method === "DELETE") {
        return { ok: true };
      }
      return {};
    });
    // Re-mount with the new mock so the initial loadVoices returns the
    // pre-existing id before the user clicks Add.
    await act(async () => {
      root.unmount();
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(Harness));
    });
    await flush();
    await flush();
    expect([...select().options].some((option) => option.value === preExistingId)).toBe(true);

    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, preExistingId);
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    const deleted = apiMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleted).toHaveLength(0);
    expect(select().value).toBe("");
    expect(patches.some((patch) => macPatch(patch) === preExistingId)).toBe(false);
    expect(alerts().some((text) => text.includes(MACOS_14))).toBe(true);
    // The pre-existing row stays listed; the user can still pick it later
    // when the gate opens.
    expect([...select().options].some((option) => option.value === preExistingId)).toBe(true);
    expect(id.value).toBe(preExistingId);
  });

  it("surfaces an honest error when the cleanup DELETE fails on a refused new personal id", async () => {
    const stored = new Map<string, { id: string; label: string; description: string }>();
    await mount();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") {
        return { voices: [...stored.values()] };
      }
      if (path === "/api/tts/custom-voice" && init?.method === "POST") {
        const body = parseCustomVoiceRequestBody(init);
        const voiceId = body.voiceId ?? "";
        const voice = { id: voiceId, label: body.label || voiceId, description: "Custom" };
        stored.set(voiceId, voice);
        return { ok: true, voice };
      }
      if (path.startsWith("/api/tts/custom-voice/") && init?.method === "DELETE") {
        throw new Error("server down");
      }
      return {};
    });
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, "personal:leftover-voice");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    const deleted = apiMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleted.map((call) => String(call[0]))).toContain("/api/tts/custom-voice/personal%3Aleftover-voice");
    // The form must tell the user the row remains on the server instead of
    // silently re-listing an unselectable orphan.
    const cleanupAlerts = alerts();
    expect(cleanupAlerts.some((text) => text.includes(MACOS_14))).toBe(true);
    expect(cleanupAlerts.some((text) => text.includes("The saved voice could not be removed"))).toBe(true);
    // The row is still persisted on the server and reloads into the picker.
    expect(stored.has("personal:leftover-voice")).toBe(true);
  });

  it("refreshes the voice list when the POST response fails to parse", async () => {
    const stored = new Map<string, { id: string; label: string; description: string }>();
    await mount();
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/tts/voices") {
        return { voices: [...stored.values()] };
      }
      if (path === "/api/tts/custom-voice" && init?.method === "POST") {
        const body = parseCustomVoiceRequestBody(init);
        const voiceId = body.voiceId ?? "";
        stored.set(voiceId, {
          id: voiceId,
          label: body.label || voiceId,
          description: "Custom",
        });
        // Return a malformed success body: missing `voice` field.  The
        // renderer must not delete this row, and must call loadVoices so
        // the user can see and remove it instead of it becoming an orphan.
        return { ok: true };
      }
      if (path.startsWith("/api/tts/custom-voice/") && init?.method === "DELETE") {
        const id = decodeURIComponent(path.slice("/api/tts/custom-voice/".length));
        stored.delete(id);
        return { ok: true };
      }
      return {};
    });
    const add = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice ID"));
    if (!add) throw new Error("missing Add Voice ID");
    await act(async () => {
      add.click();
    });
    const id = container.querySelector<HTMLInputElement>('[aria-label="Custom Voice ID"]');
    if (!id) throw new Error("missing id");
    await act(async () => {
      setInputValue(id, "personal:malformed-response");
    });
    const submit = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Add Voice"));
    if (!submit) throw new Error("missing Add Voice");
    await act(async () => {
      submit.click();
    });
    await flush();
    await flush();

    // No compensating DELETE — the renderer could not even derive the
    // encoded URL from a malformed response.
    const deleted = apiMock.mock.calls.filter((call) => call[1]?.method === "DELETE");
    expect(deleted).toHaveLength(0);
    // The persisted row reloads into the picker so the user can remove it.
    expect([...select().options].some((option) => option.value === "personal:malformed-response")).toBe(true);
    // And the still-open form explains the failure.
    expect(alerts().some((text) => text.includes("Failed to add voice identifier."))).toBe(true);
    expect(id.value).toBe("personal:malformed-response");
  });

  function installPersonalVoices(list: () => Promise<Array<{ id: string; name: string; locale?: string }>>) {
    capState.state.personalVoice = true;
    capState.state.reasonCode = undefined;
    Reflect.set(window, "ogb", {
      personalVoice: {
        isAvailable: async () => true,
        list,
        speak: async () => {},
        stop: async () => {},
      },
    });
  }

  const optionValues = (node: HTMLSelectElement) => [...node.options].map((option) => option.value);

  it("shows the MiniMax voices while the Personal Voice list is still waiting", async () => {
    installPersonalVoices(() => new Promise(() => {}));
    await mount();

    expect(optionValues(select())).toContain("custom-1");
    expect(optionValues(iphoneSelect())).toContain("custom-1");
    expect(container.textContent).not.toContain("Loading voices…");
    expect(container.textContent).toContain("Loading Personal Voices on this Mac…");
  });

  it("stops waiting for a Personal Voice list that never answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      installPersonalVoices(() => new Promise(() => {}));
      await act(async () => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        apiMock.mockResolvedValue({ voices: [] });
        root.render(createElement(Harness));
      });
      expect(container.textContent).toContain("Loading Personal Voices on this Mac…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PERSONAL_VOICE_LIST_TIMEOUT_MS);
      });
      expect(container.textContent).not.toContain("Loading Personal Voices on this Mac…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still offers a Personal Voice list that arrives after the spinner gave up", async () => {
    // The helper can park on the authorization prompt while the owner reads
    // it.  The answer that follows must still reach the Mac picker.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answer: (voices: Array<{ id: string; name: string }>) => void = () => {};
    try {
      installPersonalVoices(() => new Promise((resolve) => {
        answer = resolve;
      }));
      await act(async () => {
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        apiMock.mockResolvedValue({ voices: [] });
        root.render(createElement(Harness));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PERSONAL_VOICE_LIST_TIMEOUT_MS + 1);
      });
      expect(container.textContent).not.toContain("Loading Personal Voices on this Mac…");
      expect(optionValues(select())).not.toContain("personal:late-1");

      await act(async () => {
        answer([{ id: "personal:late-1", name: "Jay, Answered Late" }]);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(optionValues(select())).toContain("personal:late-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the shared voice and offers no iPhone picker against a harness without per-device voices", async () => {
    // Its non-strict PATCH would strip `voices` and answer 200 with the bot
    // unchanged, so the picker would snap back with no error.
    startingBot = sampleBot("", LEGACY_HARNESS);
    await mount();

    expect(container.querySelector('select[aria-label="Assistant\'s voice on iPhone"]')).toBeNull();
    expect(container.textContent).toContain(DEVICE_VOICES_NEED_UPDATE);
    await act(async () => {
      setSelectValue(select(), "custom-1");
    });
    expect(patches).toEqual([{ voice: "custom-1" }]);
    expect(select().value).toBe("custom-1");
  });

  it("offers this Mac's Personal Voices for the Mac only", async () => {
    installPersonalVoices(async () => [{ id: "personal:mac-1", name: "Jay on Mac", locale: "en-US" }]);
    await mount();

    expect(optionValues(select())).toContain("personal:mac-1");
    expect(optionValues(iphoneSelect()).some((id) => id.startsWith("personal:"))).toBe(false);

    await act(async () => {
      setSelectValue(select(), "personal:mac-1");
    });
    expect(patches.at(-1)).toEqual({ voices: { mac: "personal:mac-1" } });
    expect(select().value).toBe("personal:mac-1");
    expect(container.textContent).toContain("It plays on-device on this Mac.");
  });

  it("sets the iPhone's MiniMax voice from here without touching the Mac's", async () => {
    startingBot = sampleBot("", { mac: "custom-1" });
    await mount();

    // The harness lists personal:jay, but a Personal Voice is never offered
    // for the iPhone from this Mac.
    expect(optionValues(iphoneSelect())).not.toContain("personal:jay");

    await act(async () => {
      setSelectValue(iphoneSelect(), "custom-1");
    });
    expect(patches).toEqual([{ voices: { iphone: "custom-1" } }]);
    expect(iphoneSelect().value).toBe("custom-1");
    expect(select().value).toBe("custom-1");
  });

  it("clears only the Mac's own choice when the Mac goes back to the shared voice", async () => {
    startingBot = sampleBot("custom-1", { mac: "custom-1", iphone: "custom-1" });
    await mount();

    await act(async () => {
      setSelectValue(select(), "");
    });
    expect(patches).toEqual([{ voices: { mac: null } }]);
    expect(select().value).toBe("");
    expect(iphoneSelect().value).toBe("custom-1");
  });

  it("asks for a Mac voice when the Mac's Personal Voice is not on this Mac", async () => {
    installPersonalVoices(async () => [{ id: "personal:mac-1", name: "Jay on Mac" }]);
    startingBot = sampleBot("", { mac: "personal:iphone-only" });
    await mount();

    expect(container.textContent).toContain(PERSONAL_VOICE_NOT_ON_MAC);
    expect([...select().options].find((option) => option.value === "personal:iphone-only")?.textContent).toBe(
      "Personal Voice not on this Mac",
    );
    // Try stays on: if the voice really is missing, the helper says so.
    const tryButton = container.querySelector<HTMLButtonElement>('button[title="Hear this Apple Personal Voice"]');
    expect(tryButton?.disabled).toBe(false);
  });

  it("does not call a Personal Voice missing when the helper's list is empty", async () => {
    // The helper answers [] for a failure or a timeout, not only for a Mac
    // with no Personal Voices, so an empty list is no evidence.
    installPersonalVoices(async () => []);
    startingBot = sampleBot("", { mac: "personal:mac-voice" });
    await mount();

    expect(container.textContent).not.toContain(PERSONAL_VOICE_NOT_ON_MAC);
    expect(container.textContent).toContain("It plays on-device on this Mac.");
    const tryButton = container.querySelector<HTMLButtonElement>('button[title="Hear this Apple Personal Voice"]');
    expect(tryButton?.disabled).toBe(false);
  });

  it("clears every device that named a deleted voice", async () => {
    startingBot = sampleBot("custom-1", { mac: "custom-1", iphone: "custom-1" });
    await mount();
    const remove = container.querySelector<HTMLButtonElement>('button[title="Remove Mine from list"]');
    if (!remove) throw new Error("missing delete");
    await act(async () => {
      remove.click();
    });
    await flush();

    expect(patches).toEqual([{ voice: "", voices: { mac: null, iphone: null } }]);
  });
});
