// The Sign in needed card names a site and three actions.  It has no
// password field, and a failed action stays in a persistent card.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SignInRequestCardView } from "./SignInRequestCard";
import type { SignInRequestCardData } from "../../shared/sign-in-request.ts";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "SignInRequestCard.tsx"), "utf8");

function html(status: SignInRequestCardData["status"], error: string | null = null): string {
  return renderToStaticMarkup(
    createElement(SignInRequestCardView, {
      card: { site: "example.com", reason: "the inbox", status },
      busy: null,
      error,
      onOpen: () => {},
      onDone: () => {},
      onCancel: () => {},
      onDismissError: () => {},
    }),
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
    const rendered = html("open", "The computer did not open.");
    expect(rendered).toContain("The computer did not open.");
    expect(rendered).toContain("role=\"alert\"");
    expect(SRC).toContain("PersistentActionErrorCard");
    expect(SRC).not.toMatch(/toast/i);
  });
});
