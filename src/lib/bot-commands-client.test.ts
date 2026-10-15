import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botCommandsResponseSchema } from "../../shared/bot-commands.ts";
import { botCommandAutocompleteChoices } from "./bot-commands-client";

const fixturePath = join(
  import.meta.dirname,
  "../../shared/fixtures/bot-commands/claude-simple-desktop.json",
);
const fixture = botCommandsResponseSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));

describe("botCommandAutocompleteChoices", () => {
  it("lists enabled commands from the fixture", () => {
    const rows = botCommandAutocompleteChoices(fixture, "");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.command?.name === "stop")).toBe(true);
    expect(rows.every((row) => row.kind === "command")).toBe(true);
  });

  it("filters by command name prefix", () => {
    const rows = botCommandAutocompleteChoices(fixture, "st");
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(["status", "stop"]));
    expect(rows.every((row) => row.name.includes("st") || row.command?.label.includes("/st"))).toBe(true);
  });

  it("closes after a completed command token", () => {
    expect(botCommandAutocompleteChoices(fixture, "stop ")).toEqual([]);
  });
});
