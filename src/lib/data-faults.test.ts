import { describe, expect, it } from "vitest";

import { DATA_FAULT_KINDS, type DataFault } from "../../shared/data-fault";
import {
  dataFaultLead,
  dataFaultSentences,
  dataFaultsAreUrgent,
  dataFaultsKey,
  dataFaultText,
  fetchDataFaults,
} from "./data-faults";

const fault = (overrides: Partial<DataFault> = {}): DataFault => ({
  file: "bots.json",
  kind: "set-aside",
  reason: "it ends early (it looks cut short)",
  setAsideAs: "bots.json.corrupt-1790000000000",
  omitted: 0,
  sections: [],
  writesRefused: false,
  holdsCleanup: true,
  at: 1790000000000,
  ...overrides,
});

const reply = (body: string, init: ResponseInit = { status: 200 }): (() => Promise<Response>) => async () =>
  new Response(body, init);

describe("fetchDataFaults", () => {
  it("returns the notices the server lists", async () => {
    const faults = await fetchDataFaults(reply(JSON.stringify({ faults: [fault()] })));
    expect(faults).toEqual([fault()]);
  });

  it("calls the notices route and nothing else", async () => {
    const seen: string[] = [];
    await fetchDataFaults(async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ faults: [] }));
    });
    expect(seen).toEqual(["/api/data-faults"]);
  });

  it.each([
    ["an older server's 404", reply("<html>not found</html>", { status: 404 })],
    ["an HTML page with a 200", reply("<!doctype html><title>x</title>")],
    ["a server error", reply('{"error":"boom"}', { status: 500 })],
    ["a body that is not the expected shape", reply(JSON.stringify({ faults: [{ file: 3 }] }))],
    ["a body with no faults list", reply("{}")],
    [
      "a network failure",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("reads %s as nothing to report, never as an error", async (_label, request) => {
    await expect(fetchDataFaults(request)).resolves.toEqual([]);
  });

  it("rejects a notice from a kind this build does not know, rather than showing a half-understood one", async () => {
    const odd = { ...fault(), kind: "from-the-future" };
    await expect(fetchDataFaults(reply(JSON.stringify({ faults: [odd] })))).resolves.toEqual([]);
  });
});

describe("the words", () => {
  const every: DataFault[] = [
    fault(),
    fault({ file: "groups.json", kind: "partial", omitted: 2, setAsideAs: "groups.json.corrupt-1790000000001" }),
    fault({ file: "routines.json", kind: "unreadable", reason: "it could not be read (EISDIR)", setAsideAs: null, writesRefused: true }),
    fault({ file: "config.json", kind: "config-ignored", reason: "it is empty", setAsideAs: null, holdsCleanup: false }),
    fault({ file: "config.json", kind: "config-partial", sections: ["autoUpdate", "instances.broken"], setAsideAs: null, holdsCleanup: false }),
    fault({ file: "config.json", kind: "set-aside", setAsideAs: "config.json.corrupt-1790000000002", holdsCleanup: false }),
    fault({ kind: "left-over", reason: "an earlier problem with it" }),
  ];

  it("covers every kind the server can raise", () => {
    expect(new Set(every.map((entry) => entry.kind))).toEqual(new Set(DATA_FAULT_KINDS));
  });

  it("names the file, ends every sentence with a full stop, and uses the wide gap between them", () => {
    for (const entry of every) {
      const { lead, body } = dataFaultText(entry);
      expect(lead).toMatch(/\.$/);
      const sentences = dataFaultSentences(entry);
      expect(sentences.length).toBeGreaterThan(1);
      for (const sentence of sentences) expect(sentence).toMatch(/\.$/);
      expect(body).toBe(sentences.join("  "));
      expect(`${lead} ${body}`).toContain(entry.file === "config.json" ? "config.json" : entry.file);
    }
  });

  it("says the set-aside file was moved, not deleted, and where to look", () => {
    const text = dataFaultSentences(fault()).join(" ");
    expect(text).toContain("bots.json.corrupt-1790000000000");
    expect(text).toContain("Nothing was deleted.");
    expect(text).toContain("quit BotFleet");
  });

  it("says that cleanup is paused only when it is", () => {
    expect(dataFaultSentences(fault()).join(" ")).toContain("cleanup");
    expect(dataFaultSentences(fault({ holdsCleanup: false })).join(" ")).not.toContain("cleanup");
  });

  it("says plainly when changes are not being saved", () => {
    expect(dataFaultLead(every[2]!)).toContain("not being saved");
    expect(dataFaultSentences(fault({ kind: "partial", omitted: 1, writesRefused: true, setAsideAs: null })).join(" ")).toContain(
      "is not saving changes to bots.json",
    );
  });

  it("agrees with the count", () => {
    expect(dataFaultSentences(fault({ kind: "partial", omitted: 1 }))[0]).toContain("1 entry in bots.json could not be read and was left out.");
    expect(dataFaultSentences(fault({ kind: "partial", omitted: 3 }))[0]).toContain("3 entries in bots.json could not be read and were left out.");
  });

  it("lists the settings that were left out", () => {
    expect(dataFaultSentences(every[4]!)[0]).toContain("autoUpdate, instances.broken");
  });

  it("calls them bots, never agents", () => {
    for (const entry of every) {
      const all = `${dataFaultLead(entry)} ${dataFaultSentences(entry).join(" ")}`;
      expect(all).not.toMatch(/\bagent/i);
    }
  });

  it("uses no ASCII double space; the gap between sentences is a no-break space plus a space", () => {
    for (const entry of every) expect(dataFaultText(entry).body).not.toContain("  ");
  });
});

describe("the set as a whole", () => {
  it("is urgent only when something is being refused", () => {
    expect(dataFaultsAreUrgent([fault(), fault({ file: "groups.json" })])).toBe(false);
    expect(dataFaultsAreUrgent([fault(), fault({ file: "groups.json", writesRefused: true })])).toBe(true);
    expect(dataFaultsAreUrgent([])).toBe(false);
  });

  it("changes its key when a notice appears or changes, so a dismissal does not hide a new problem", () => {
    const one = [fault()];
    const same = [fault()];
    const more = [fault(), fault({ file: "routines.json" })];
    const changed = [fault({ kind: "left-over" })];
    expect(dataFaultsKey(same)).toBe(dataFaultsKey(one));
    expect(dataFaultsKey(more)).not.toBe(dataFaultsKey(one));
    expect(dataFaultsKey(changed)).not.toBe(dataFaultsKey(one));
    expect(dataFaultsKey([])).toBe("");
  });
});
