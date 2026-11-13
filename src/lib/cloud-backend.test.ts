import { describe, expect, it } from "vitest";

import { resolveCloudBackend } from "../../server/computer-grants.ts";
import type { CloudBackend } from "../../server/contracts.ts";
import { botCloudBackend, cloudBackendInherited, cloudDestinationLabel } from "./cloud-backend";

/** What the two panels did before this module existed.  Kept here so the
 * regression has a name: every case below where this disagrees with
 * `botCloudBackend` is a case where the panel described the wrong machine. */
const legacyClientRule = (bot: { cloudBackend?: CloudBackend }) => bot.cloudBackend ?? "box";

const backends: Array<CloudBackend | undefined> = [undefined, "box", "vps"];

describe("botCloudBackend", () => {
  it("answers exactly what the server's resolver answers", () => {
    for (const own of backends) {
      for (const workspaceDefault of backends) {
        expect(botCloudBackend({ cloudBackend: own }, workspaceDefault)).toBe(
          resolveCloudBackend(own, workspaceDefault),
        );
      }
    }
  });

  it("lets an unset bot inherit a vps workspace default", () => {
    // The whole bug in one assertion: the panel used to say "box" here while
    // the status endpoint sent a VPS body and the turn opened a VPS.
    expect(botCloudBackend({}, "vps")).toBe("vps");
    expect(legacyClientRule({})).toBe("box");
  });

  it("keeps the bot's own choice ahead of the workspace default", () => {
    expect(botCloudBackend({ cloudBackend: "box" }, "vps")).toBe("box");
    expect(botCloudBackend({ cloudBackend: "vps" }, "box")).toBe("vps");
  });

  it("falls back to box only when nothing else answers", () => {
    expect(botCloudBackend({}, undefined)).toBe("box");
    expect(botCloudBackend({})).toBe("box");
  });

  it("agrees with the old rule wherever the default is box, and only there", () => {
    for (const own of backends) {
      const bot = { cloudBackend: own };
      expect(botCloudBackend(bot, "box")).toBe(legacyClientRule(bot));
    }
    // ...and differs for exactly the inheriting bot under a vps default.
    const disagreements = backends.filter(
      (own) => botCloudBackend({ cloudBackend: own }, "vps") !== legacyClientRule({ cloudBackend: own }),
    );
    expect(disagreements).toEqual([undefined]);
  });
});

describe("cloudBackendInherited", () => {
  it("is true only while the bot carries no choice of its own", () => {
    expect(cloudBackendInherited({})).toBe(true);
    expect(cloudBackendInherited({ cloudBackend: undefined })).toBe(true);
    expect(cloudBackendInherited({ cloudBackend: "box" })).toBe(false);
    expect(cloudBackendInherited({ cloudBackend: "vps" })).toBe(false);
  });

  it("stays true for a bot whose inherited value matches the shipped fallback", () => {
    // "Following the default" is the honest description even when the default
    // is box, because a later flip of that default moves this bot too.
    expect(cloudBackendInherited({})).toBe(true);
    expect(botCloudBackend({}, "box")).toBe("box");
  });
});

describe("cloudDestinationLabel", () => {
  it("names the machine the bot will actually open", () => {
    expect(cloudDestinationLabel("vps")).toBe("Self-hosted VPS");
    expect(cloudDestinationLabel("box")).toBe("ASCII.dev Box");
  });

  it("gives an inheriting bot the label of the default it follows", () => {
    expect(cloudDestinationLabel(botCloudBackend({}, "vps"))).toBe("Self-hosted VPS");
    expect(cloudDestinationLabel(botCloudBackend({}, "box"))).toBe("ASCII.dev Box");
  });
});
