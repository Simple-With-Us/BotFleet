import { describe, expect, it } from "vitest";

import { validateCommandArgs } from "./chat-commands.ts";
import type { BotCommand } from "../shared/bot-commands.ts";

const withArgs: BotCommand = {
  id: "engine:compact",
  name: "compact",
  label: "/compact",
  title: "Compact",
  description: "Summarize.",
  source: "engine",
  invoke: "server",
  clientAction: null,
  args: { required: false, hint: "Optional focus", maxLength: 500 },
  availability: "idle",
  enabled: true,
  disabledReason: null,
  runsModelTurn: true,
  collidesWith: null,
};

describe("validateCommandArgs", () => {
  it("rejects arguments that start with a slash", () => {
    const outcome = validateCommandArgs(withArgs, "/model opus");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/slash/i);
  });

  it("rejects arguments with line breaks", () => {
    const outcome = validateCommandArgs(withArgs, "focus\nsecond");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/line breaks/i);
  });
});
