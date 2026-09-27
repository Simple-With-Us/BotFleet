import { describe, expect, it } from "vitest";

import { findPackages, formatUiNodes, parseDevices, parseLaunchablePackages, parseUiNodes } from "./phone-proxy.ts";

describe("phone MCP parsing", () => {
  it("keeps physical USB devices distinguishable from network and emulator transports", () => {
    expect(parseDevices(`List of devices attached
USB123 device product:husky model:Pixel_8 usb:1-2 transport_id:4
emulator-5554 device product:sdk model:Emulator transport_id:6
192.0.2.4:5555 device product:remote model:Remote transport_id:7
`)).toEqual([
      { serial: "USB123", state: "device", connection: "usb", model: "Pixel 8" },
      { serial: "emulator-5554", state: "device", connection: "emulator", model: "Emulator" },
      { serial: "192.0.2.4:5555", state: "device", connection: "network", model: "Remote" },
    ]);
  });

  it("extracts unique launchable packages", () => {
    expect(parseLaunchablePackages(`2 activities found:
      com.ubercab/.presidio.RootActivity
      net.skyscanner.android.main/net.skyscanner.shell.SplashActivity
      com.ubercab/.presidio.RootActivity
    `)).toEqual(["com.ubercab", "net.skyscanner.android.main"]);
  });

  it("resolves common human app names before using package-name heuristics", () => {
    const packages = ["com.ubercab", "net.skyscanner.android.main", "com.example.other"];
    expect(findPackages("Uber", packages)).toEqual(["com.ubercab"]);
    expect(findPackages("Skyscanner", packages)).toEqual(["net.skyscanner.android.main"]);
  });

  it("turns Android UI XML into tap-ready visible nodes", () => {
    expect(parseUiNodes(`<?xml version="1.0"?><hierarchy><node text="Where to?" resource-id="com.ubercab:id/input" class="android.widget.TextView" content-desc="Destination" bounds="[12,100][400,180]" /></hierarchy>`)).toEqual([
      { text: "Where to?", description: "Destination", id: "com.ubercab:id/input", className: "android.widget.TextView", bounds: [12, 100, 400, 180] },
    ]);
  });

  it("clips large Unicode and escaped labels while retaining the node's id and tap bounds", () => {
    const nodes = [{
      text: `Book 🚖 ${"long\\\n".repeat(100)}`,
      description: "Destination details ".repeat(40),
      id: "com.ubercab:id/destination",
      className: "android.widget.TextView",
      bounds: [12, 100, 400, 180] as [number, number, number, number],
    }];
    const output = formatUiNodes(nodes);
    expect(output).toContain('id="com.ubercab:id/destination" bounds=12,100,400,180');
    expect(output).toContain("truncated labels: 2");
    expect(output).toContain("Shown: 1; omitted: 0");
    expect(output).toContain("…");
    expect(output).not.toContain("long\\\n".repeat(20));
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12 * 1024);
  });

  it("caps the complete screen output and reports all omitted nodes", () => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      text: `Destination ${index} ${"x".repeat(200)}`,
      description: "",
      id: `com.example:id/row_${index}`,
      className: "android.widget.Button",
      bounds: [0, index, 300, index + 1] as [number, number, number, number],
    }));
    const output = formatUiNodes(nodes);
    const summary = /Shown: (\d+); omitted: (\d+); truncated labels: (\d+)\.$/.exec(output);
    expect(summary).not.toBeNull();
    const shown = Number(summary![1]);
    expect(shown).toBeLessThan(250);
    expect(Number(summary![2])).toBe(300 - shown);
    expect(Number(summary![3])).toBe(shown);
    expect(output).toContain('id="com.example:id/row_0" bounds=0,0,300,1');
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12 * 1024);
  });

  it("reports the 250-node cap even when the byte budget has room", () => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      text: String(index), description: "", id: "", className: "", bounds: [0, 0, 1, 1] as [number, number, number, number],
    }));
    expect(formatUiNodes(nodes)).toContain("Shown: 250; omitted: 50; truncated labels: 0.");
  });
});
