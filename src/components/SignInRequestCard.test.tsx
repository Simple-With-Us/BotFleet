// The Sign in needed card names a site and three actions.  It has no
// password field, and a failed action stays in a persistent card.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ dispatch: vi.fn() }),
    api: vi.fn(),
  };
});

import { SignInRequestCard } from "./SignInRequestCard";
import type { Message } from "@/state/store";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "SignInRequestCard.tsx"), "utf8");

function message(status: "open" | "done" | "cancelled" | "replaced"): Message {
  return {
    id: "msg-sign",
    role: "bot",
    kind: "sign-in",
    at: 0,
    signIn: { site: "example.com", reason: "the inbox", status },
  };
}

function html(status: "open" | "done" | "cancelled" | "replaced"): string {
  return renderToStaticMarkup(
    createElement(SignInRequestCard, { botId: "bot-1", threadId: "thread-1", message: message(status) }),
  );
}

describe("SignInRequestCard", () => {
  it("names the site and offers Open, Done, and Cancel", () => {
    const rendered = html("open");
    expect(rendered).toContain("Sign in needed");
    expect(rendered).toContain("example.com");
    expect(rendered).toContain("the inbox");
    expect(rendered).toContain("BotFleet never sees the password.");
    expect(rendered).toContain(">Open<");
    expect(rendered).toContain(">Done<");
    expect(rendered).toContain(">Cancel<");
    expect(rendered).not.toMatch(/type="password"/);
    expect(rendered).not.toContain("<input");
  });

  it("drops the actions once the card is settled", () => {
    expect(html("done")).toContain("Signed in on this bot");
    expect(html("done")).not.toContain(">Done<");
    expect(html("cancelled")).toContain("You declined this sign-in.");
    expect(html("cancelled")).not.toContain(">Cancel<");
    expect(html("replaced")).toContain("A newer sign-in request replaced this one.");
    expect(html("replaced")).not.toContain(">Open<");
  });

  it("keeps action failures in a persistent card", () => {
    expect(SRC).toContain("PersistentActionErrorCard");
    expect(SRC).not.toMatch(/toast/i);
  });
});
