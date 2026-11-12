// What the bot On/Off switch draws, SSR style like the repo's other component
// tests (`renderToStaticMarkup`, no DOM): the settings card, the composer's
// disabled state, the "Off" badge, and the source-level promises that tie them
// into the sidebar, the chat header and the composer.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BOT_OFF_AFTER_TURN,
  BOT_OFF_COMPOSER_NOTICE,
  BOT_OFF_KEEP_ON,
  BOT_OFF_STOP_AND_POWER_OFF,
  BOT_OFF_TURN_ON_LABEL,
  botOffWhileRunningBody,
  botOffWhileRunningTitle,
} from "../../shared/bot-power";
import { applyBotPatch } from "@/state/bot-patch-queue";
import { roomRespondersForComposer } from "@/lib/group-routing";
import { BotOffBadge } from "./BotOffBadge";
import { BotOffComposer } from "./BotOffComposer";
import { BOT_POWER_COPY, BotPowerToggle } from "./BotPowerToggle";

const DIR = dirname(fileURLToPath(import.meta.url));
const src = (file: string) => readFileSync(join(DIR, file), "utf8").replace(/\r\n/g, "\n");

describe("BotPowerToggle", () => {
  const render = (off: boolean) =>
    renderToStaticMarkup(createElement(BotPowerToggle, { off, onChange: () => {} }));

  it("is a labelled switch that reads On when the bot is on", () => {
    const html = render(false);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Bot On/Off"');
    expect(html).toContain(">On</span>");
    expect(html).toContain("This bot answers chat, runs its routines and webhooks");
  });

  it("reads Off, unchecked, and says exactly what stops, when the bot is off", () => {
    const html = render(true);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(">Off</span>");
    expect(html).toContain("Nothing new starts for this bot");
    expect(html).toContain("a turn already running finishes");
    expect(html).toContain("Its chat stays visible");
  });

  it("keeps the sentence gap as a real non-breaking space, never the entity", () => {
    for (const copy of [BOT_POWER_COPY.on, BOT_POWER_COPY.off]) {
      expect(copy).toContain("  ");
      expect(copy).not.toContain("&nbsp;");
      expect(copy).not.toMatch(/\bagent\b/i);
    }
    expect(render(true)).not.toContain("&amp;nbsp;");
  });
});

describe("BotOffComposer", () => {
  const html = renderToStaticMarkup(createElement(BotOffComposer, { botName: "Scout", onTurnOn: () => {} }));

  it("replaces the input with the disabled notice and a Turn On button", () => {
    expect(html).toContain(BOT_OFF_COMPOSER_NOTICE);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(`>${BOT_OFF_TURN_ON_LABEL}</button>`);
    expect(html).toContain('aria-label="Turn On Scout"');
    // the way out is the only control: no text box is drawn
    expect(html).not.toContain("<textarea");
  });

  it("says it in the owner's words, with the gap preserved", () => {
    expect(BOT_OFF_COMPOSER_NOTICE.replace("  ", "  ")).toBe("This bot is off.  Turn it on to chat.");
  });
});

describe("BotOffBadge", () => {
  it("is the word Off, labelled for assistive tech", () => {
    const html = renderToStaticMarkup(createElement(BotOffBadge, {}));
    expect(html).toContain(">Off</span>");
    expect(html).toContain('aria-label="Off"');
    expect(html).toContain('title="This bot is off"');
  });
});

describe("wiring into the app", () => {
  it("sends off through the bot PATCH queue and applies it optimistically", () => {
    const bot = { id: "b", name: "Scout", off: false, voices: null };
    const patched = applyBotPatch(bot, { off: true });
    expect(patched.off).toBe(true);
    // the optimistic copy is a new object; the one the store held is untouched
    expect(bot.off).toBe(false);
    expect(src("../state/bot-patch-queue.ts")).toContain('| "off"');
  });

  it("swaps the composer for the disabled state only for a 1:1 bot that is Off", () => {
    const composer = src("Composer.tsx");
    const wrapper = composer.slice(composer.indexOf("export function Composer("), composer.indexOf("function ComposerInner("));
    expect(wrapper).toContain("bot.off === true");
    expect(wrapper).toContain("!props.group");
    expect(wrapper).toContain("<BotOffComposer");
    expect(wrapper).toContain('patch: { off: false }');
    // the real composer, and with it the draft, comes back untouched
    expect(wrapper).toContain("<ComposerInner {...props} />");
  });

  it("marks an Off bot in the sidebar (dimmed avatar plus the Off label) and in the chat header", () => {
    const sidebar = src("Sidebar.tsx");
    expect(sidebar).toContain('data-off={bot.off === true ? "true" : undefined}');
    expect(sidebar).toContain("data-[off=true]:opacity-50");
    expect(sidebar).toContain("{bot.off === true && <BotOffBadge");
    expect(src("ChatView.tsx")).toContain("{bot.off === true && <BotOffBadge />}");
  });

  it("puts the switch in the Bot Profile panel, and asks a working bot before it flips", () => {
    const panel = src("SettingsPanel.tsx");
    expect(panel).toContain("<BotPowerToggle");
    expect(panel).toContain('off={bot.off === true}');
    // Only a bot with a turn in flight is asked: an idle bot has nothing to
    // stop, so its switch flips straight through.
    expect(panel).toContain("if (off && bot.busy)");
    expect(panel).toContain("patch({ off });");
  });

  it("offers a working bot all three answers, and each one does what it says", () => {
    const panel = src("SettingsPanel.tsx");
    expect(panel).toContain("botOffWhileRunningTitle(bot.name)");
    expect(panel).toContain("botOffWhileRunningBody(bot.name)");
    expect(panel).toContain("cancelLabel={BOT_OFF_KEEP_ON}");
    expect(panel).toContain("altLabel={BOT_OFF_AFTER_TURN}");
    expect(panel).toContain("confirmLabel={BOT_OFF_STOP_AND_POWER_OFF}");

    // Letting the turn finish: power off, and interrupt nothing.
    // Other dialogs in this panel have an `onConfirm` too, so the search for
    // ours starts at our `onAlt` rather than at the top of the file.
    const altAt = panel.indexOf("onAlt={() =>");
    const confirmAt = panel.indexOf("onConfirm={() =>", altAt);
    expect(altAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeGreaterThan(altAt);
    const alt = panel.slice(altAt, confirmAt);
    expect(alt).toContain("patch({ off: true });");
    expect(alt).not.toContain("interrupt");

    // Stopping it: power off AND stop the turn in flight.
    const confirm = panel.slice(confirmAt, panel.indexOf("/>", confirmAt));
    expect(confirm).toContain("patch({ off: true });");
    expect(confirm).toContain('dispatch({ type: "interrupt", botId: bot.id });');
  });

  it("names the bot and both answers in the owner's words, with the gap preserved", () => {
    expect(botOffWhileRunningTitle("Scout")).toBe("Scout Is Working");
    expect(botOffWhileRunningBody("Scout").replace(/  /g, "  ")).toBe(
      "Turning Scout off stops new work, but the turn running now will keep going.  Stop it now, or let it finish first.",
    );
    const copy = [botOffWhileRunningBody("Scout"), botOffWhileRunningTitle("Scout")];
    for (const text of [...copy, BOT_OFF_STOP_AND_POWER_OFF, BOT_OFF_AFTER_TURN, BOT_OFF_KEEP_ON]) {
      expect(text).not.toContain("&nbsp;");
      expect(text).not.toMatch(/\bagent\b/i);
    }
    // The gap is a real U+00A0 plus a space, never the six-character entity.
    expect(botOffWhileRunningBody("Scout")).toContain("  ");
  });

  it("keeps the room composer's preview in step with the server's responder rules", () => {
    const members = [{ id: "a", name: "Scout", off: true }, { id: "b", name: "Pixel" }];
    expect(roomRespondersForComposer("hi @Scout", members, { defaultResponder: { kind: "everyone" } }).map((m) => m.id)).toEqual(["b"]);
    expect(roomRespondersForComposer("@everyone", members, { defaultResponder: { kind: "mentions" } }).map((m) => m.id)).toEqual(["b"]);
  });
});
