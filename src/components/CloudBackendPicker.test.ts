import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { botCloudBackend, cloudBackendInherited } from "@/lib/cloud-backend";
import { CloudBackendPicker } from "./CloudBackendPicker";

const markup = (props: Parameters<typeof CloudBackendPicker>[0]) =>
  renderToStaticMarkup(createElement(CloudBackendPicker, props));

/** The lit segment, read the way a person reads it: `bg-control` is the class
 * the selected button carries and the unselected one does not. */
const litSegment = (html: string): "box" | "vps" | null => {
  const buttons = html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs) ?? [];
  const lit = buttons.filter((b) => b.includes("bg-control ") || /class="[^"]*bg-control"/.test(b));
  if (lit.length !== 1) return null;
  if (lit[0].includes("Self-hosted VPS")) return "vps";
  return lit[0].includes(">ASCII.dev Box<") || lit[0].includes(">Box<") ? "box" : null;
};

/** The Self-hosted VPS segment's markup, attributes included. */
const vpsButton = (html: string): string => {
  const buttons = html.match(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs) ?? [];
  return buttons.find((b) => b.includes("Self-hosted VPS")) ?? "";
};

const describedById = (buttonHtml: string): string | null =>
  buttonHtml.match(/aria-describedby="([^"]+)"/)?.[1] ?? null;

/** The text of the element carrying `id`, or null when there is none. */
const textForId = (html: string, id: string): string | null => {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<div id="${escaped}"[^>]*>([^<]*)</div>`))?.[1] ?? null;
};

const base = { vpsSupported: true, onChange: () => {} };

describe("CloudBackendPicker", () => {
  it("lights the segment for the backend actually in effect", () => {
    expect(litSegment(markup({ ...base, value: "box" }))).toBe("box");
    expect(litSegment(markup({ ...base, value: "vps" }))).toBe("vps");
  });

  it("lights VPS for a bot inheriting a vps workspace default", () => {
    // The panel passes the resolved value, so a bot that never opened this
    // control still sees the segment matching where its turn will run.
    const bot = {};
    const html = markup({
      ...base,
      value: botCloudBackend(bot, "vps"),
      inherited: cloudBackendInherited(bot),
    });
    expect(litSegment(html)).toBe("vps");
  });

  it("says the choice is inherited, and that picking pins it", () => {
    const html = markup({ ...base, value: "vps", inherited: true });
    expect(html).toContain("has not chosen one");
    expect(html).toContain("App Settings → Computers");
    expect(html).toContain("stops following");
  });

  it("stays silent about inheritance once the bot has chosen", () => {
    const html = markup({ ...base, value: "vps", inherited: false });
    expect(html).not.toContain("has not chosen one");
    // An omitted prop must read the same as an explicit false.
    expect(markup({ ...base, value: "vps" })).not.toContain("has not chosen one");
  });

  it("separates the note's two sentences with a non-breaking gap", () => {
    // Shipped copy renders in HTML, so the gap has to be a character the
    // renderer keeps rather than two spaces it collapses.
    const html = markup({ ...base, value: "box", inherited: true });
    expect(html).toContain("Computers.  Picking");
  });

  it("lights VPS while disabling it, for an inheriting bot on an engine that cannot drive one", () => {
    // Reachable and newly common: a bot inheriting a "vps" default on an
    // engine that cannot use it.  The segment is highlighted because that IS
    // where the turn would land, and greyed because this engine cannot take
    // it there — with the reason visible under the control, not in a tooltip
    // a disabled button may never show.
    const html = markup({ ...base, vpsSupported: false, value: "vps", inherited: true });
    expect(litSegment(html)).toBe("vps");
    expect(vpsButton(html)).toContain("disabled");
    expect(html).toContain(
      "This engine can&#x27;t run a desktop on your own server.\u00a0 Pick an engine that can control a computer, such as Claude, to use Self-hosted VPS.",
    );
    expect(html).not.toContain("Self-hosted VPS requires");
    expect(html).not.toContain("ACP");
  });

  it("still disables VPS when the engine cannot drive one", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box", inherited: true });
    expect(vpsButton(html)).toContain("disabled");
    expect(html).toContain("can&#x27;t run a desktop on your own server.");
  });

  it("names the engine in the disabled note when engineName is given", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box", engineName: "MiniMax" });
    expect(html).toContain(
      "MiniMax can&#x27;t run a desktop on your own server.\u00a0 Pick an engine that can control a computer, such as Claude, to use Self-hosted VPS.",
    );
    expect(html).not.toContain("This engine can&#x27;t run a desktop");
  });

  it("falls back to This engine when engineName is omitted", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box" });
    expect(html).toContain("This engine can&#x27;t run a desktop on your own server.");
    // A blank name must read the same as an omitted one.
    expect(markup({ ...base, vpsSupported: false, value: "box", engineName: "  " })).toContain(
      "This engine can&#x27;t run a desktop on your own server.",
    );
  });

  it("describes the disabled segment with the visible note, not a tooltip", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box", engineName: "MiniMax" });
    const button = vpsButton(html);
    const id = describedById(button);
    expect(id).not.toBeNull();
    expect(textForId(html, id!)).toContain("MiniMax can&#x27;t run a desktop on your own server.");
    expect(button).not.toContain("title=");
  });

  it("separates the disabled note's two sentences with a non-breaking gap", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box" });
    expect(html).toContain("server.\u00a0 Pick");
  });

  it("shows no disabled note and leaves VPS enabled when the engine can drive one", () => {
    const html = markup({ ...base, vpsSupported: true, value: "box", engineName: "MiniMax" });
    expect(html).not.toContain("run a desktop on your own server.");
    expect(vpsButton(html)).not.toContain("disabled");
    expect(describedById(vpsButton(html))).toBeNull();
  });
});
