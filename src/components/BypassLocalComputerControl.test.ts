import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BypassLocalComputerControl } from "./BypassLocalComputerControl";

const noop = () => {};

describe("BypassLocalComputerControl", () => {
  it("stays off, and says so, while Bypass Permissions is on", () => {
    const html = renderToStaticMarkup(createElement(BypassLocalComputerControl, {
      bypassPermissions: true,
      bypassLocalComputer: false,
      onTurnOff: noop,
      onRequestOn: noop,
    }));
    expect(html).toContain("Bypass Including This Mac");
    expect(html).toContain("Off.");
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("Turn on Bypass Permissions first");
  });

  it("shows the on copy only when the switch is on", () => {
    const html = renderToStaticMarkup(createElement(BypassLocalComputerControl, {
      bypassPermissions: true,
      bypassLocalComputer: true,
      onTurnOff: noop,
      onRequestOn: noop,
    }));
    expect(html).toContain("Nothing this bot does on this Mac asks.");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("bg-danger");
  });

  it("is disabled until Bypass Permissions is on", () => {
    const html = renderToStaticMarkup(createElement(BypassLocalComputerControl, {
      bypassPermissions: false,
      bypassLocalComputer: false,
      onTurnOff: noop,
      onRequestOn: noop,
    }));
    expect(html).toContain('disabled=""');
    expect(html).toContain("Turn on Bypass Permissions first");
    expect(html).toContain('aria-checked="false"');
  });
});
