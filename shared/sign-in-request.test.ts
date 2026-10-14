import { describe, expect, it } from "vitest";

import {
  signInBodyHasSecret,
  signInReason,
  signInResumePrompt,
  signInSite,
} from "./sign-in-request.ts";

describe("signInSite", () => {
  it("accepts a hostname and a bare https origin", () => {
    expect(signInSite("Example.COM")).toBe("example.com");
    expect(signInSite("https://accounts.example.com")).toBe("accounts.example.com");
    expect(signInSite("https://example.com/")).toBe("example.com");
  });

  it("refuses userinfo, passwords, paths, and non-hosts", () => {
    expect(signInSite("user:hunter2@example.com")).toBeNull();
    expect(signInSite("https://user:hunter2@example.com/login")).toBeNull();
    expect(signInSite("example.com/login")).toBeNull();
    expect(signInSite("localhost")).toBeNull();
    expect(signInSite("")).toBeNull();
    expect(signInSite("not a host")).toBeNull();
    expect(signInSite("a".repeat(300))).toBeNull();
  });
});

describe("sign-in card secrets", () => {
  it("trims a reason and never treats a password field as card data", () => {
    expect(signInReason("  need the inbox  ")).toBe("need the inbox");
    expect(signInReason("x".repeat(400))).toHaveLength(280);
    expect(signInBodyHasSecret({ threadId: "t1" })).toBe(false);
    expect(signInBodyHasSecret({ password: "hunter2" })).toBe(true);
    expect(signInBodyHasSecret({ PASSWORD: "hunter2" })).toBe(true);
    expect(signInBodyHasSecret({ Otp: "123456" })).toBe(true);
    expect(signInBodyHasSecret({ otp: "123456" })).toBe(true);
    expect(signInBodyHasSecret({ password: "" })).toBe(false);
    expect(signInBodyHasSecret(null)).toBe(false);
    expect(signInBodyHasSecret(["password"])).toBe(false);
  });

  it("tells the bot to check the screen and never to ask for a password", () => {
    expect(signInResumePrompt("example.com", "done")).toContain("Check that the site shows them signed in");
    expect(signInResumePrompt("example.com", "done")).toContain("never receive their password");
    expect(signInResumePrompt("example.com", "cancelled")).toContain("declined to sign in");
    expect(signInResumePrompt("example.com", "cancelled")).toContain("Do not ask them to paste a password");
    expect(signInResumePrompt("example.com", "done")).toContain("Do not ask them to paste a password");
  });
});
