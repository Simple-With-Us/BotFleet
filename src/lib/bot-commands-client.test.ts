import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botCommandsResponseSchema } from "../../shared/bot-commands.ts";
import {
  botCommandAutocompleteChoices,
  parseBotCommandsResponseForClient,
} from "./bot-commands-client";

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

describe("parseBotCommandsResponseForClient", () => {
  it("accepts the strict fixture unchanged", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const menu = parseBotCommandsResponseForClient(raw);
    expect(menu?.botId).toBe("b-atlas");
    expect(menu?.groups[0]?.commands.length).toBeGreaterThan(0);
  });

  it("ignores extra fields and a bumped schemaVersion", () => {
    const base = JSON.parse(readFileSync(fixturePath, "utf8"));
    const raw = { ...base, schemaVersion: 2, futureField: { nested: true } };
    const menu = parseBotCommandsResponseForClient(raw);
    expect(menu).not.toBeNull();
    expect(menu?.schemaVersion).toBe(1);
  });

  it("drops commands with unknown clientAction but keeps the rest", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8"));
    const before = raw.groups[0].commands.length;
    raw.groups[0].commands.push({
      id: "botfleet:future",
      name: "future",
      label: "/future",
      title: "Future",
      description: "Not implemented yet on desktop.",
      source: "botfleet",
      invoke: "client",
      clientAction: "future-picker",
      args: null,
      availability: "always",
      enabled: true,
      disabledReason: null,
      runsModelTurn: false,
      collidesWith: null,
    });
    const menu = parseBotCommandsResponseForClient(raw);
    expect(menu?.groups[0]?.commands.length).toBe(before);
  });
});
