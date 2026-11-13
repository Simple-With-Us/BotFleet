import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("getOrCreateChannel", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("creates a DM with no Apps/Work section even when the sender has one", () => {
    const store = new Store(selection);
    const from = store.createBot({ section: "Apps" });
    const target = store.createBot({ section: "Work" });
    const channel = getOrCreateChannel(store, from, target);
    expect(channel.dm).toBe(true);
    expect(channel.section).toBeFalsy();
    expect(channel.memberIds).toEqual(expect.arrayContaining([from.id, target.id]));
  });

  it("clears a leftover section on an existing DM instead of moving it into the sender's roster", () => {
    const store = new Store(selection);
    const from = store.createBot({ section: "Apps" });
    const target = store.createBot();
    const leftover = store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true, "Apps");
    const channel = getOrCreateChannel(store, from, target);
    expect(channel.id).toBe(leftover.id);
    expect(channel.section).toBeFalsy();
  });
});
