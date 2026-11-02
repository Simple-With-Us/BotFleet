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
    // Reachable and newly common: a boxAgent bot inheriting a "vps" default.
    // The segment is highlighted because that IS where the turn would land,
    // and greyed because this engine cannot take it there.
    const html = markup({ ...base, vpsSupported: false, value: "vps", inherited: true });
    expect(litSegment(html)).toBe("vps");
    expect(html).toContain("Self-hosted VPS requires Claude or an ACP engine");
  });

  it("still disables VPS when the engine cannot drive one", () => {
    const html = markup({ ...base, vpsSupported: false, value: "box", inherited: true });
    expect(html).toContain("Self-hosted VPS requires Claude or an ACP engine");
    expect(html).toContain("disabled");
  });
});
