import { describe, expect, it } from "vitest";
import { hostAwareAllowedComputers, matchesLocalAutoConsent, requiresLocalAutoConsent } from "./local-auto-consent";

describe("fleet local Auto consent", () => {
  const bots = [{ id: "a", name: "Ada" }, { id: "b", name: "Lin" }];
  it("accepts an unchanged set regardless of display order", () => {
    expect(matchesLocalAutoConsent([...bots].reverse(), bots)).toBe(true);
  });
  it("refuses missing, added, removed, renamed, or duplicate identities", () => {
    for (const consent of [true, null, [], [bots[0]], [...bots, { id: "c", name: "Sam" }],
      [bots[0], bots[0]], [bots[0], { id: "b", name: "Changed" }], [bots[0], { id: "c", name: "Lin" }]]) {
      expect(matchesLocalAutoConsent(consent, bots)).toBe(false);
    }
  });

  it("covers explicit, inherited, and automatic host grants without undoing Off", () => {
    expect(requiresLocalAutoConsent(["local"], ["cloud"], ["cloud"])).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["local"], ["cloud"])).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["cloud"], null)).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], null)).toBe(true);
    expect(requiresLocalAutoConsent(undefined, undefined, ["cloud"])).toBe(false);
    expect(requiresLocalAutoConsent([], ["local"], null)).toBe(false);
  });

  it("keeps explicit and inherited Local consent even when Auto cannot mount the host", () => {
    const linux = { hostPlatform: "linux", providerSupportsLocal: true };
    const unsupported = { hostPlatform: "darwin", providerSupportsLocal: false };
    expect(requiresLocalAutoConsent(["local"], ["cloud"], ["cloud"], linux)).toBe(true);
    expect(requiresLocalAutoConsent(["local"], ["cloud"], ["cloud"], unsupported)).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["local"], ["cloud"], linux)).toBe(true);
    expect(requiresLocalAutoConsent(undefined, ["local"], null, unsupported)).toBe(true);
  });

  it("limits automatic-host consent to Darwin engines that can broker host approvals", () => {
    expect(requiresLocalAutoConsent(undefined, [], null, { hostPlatform: "darwin" })).toBe(true);
    expect(requiresLocalAutoConsent(undefined, [], null, {
      hostPlatform: "darwin",
      providerSupportsLocal: true,
    })).toBe(true);
    expect(requiresLocalAutoConsent(undefined, [], null, {
      hostPlatform: "darwin",
      providerSupportsLocal: false,
    })).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], null, { hostPlatform: "linux" })).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], null, { hostPlatform: "win32" })).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], null, { hostPlatform: "other" })).toBe(false);
    expect(requiresLocalAutoConsent(undefined, undefined, ["cloud"], {
      hostPlatform: "darwin",
      providerSupportsLocal: true,
    })).toBe(false);
  });

  it("narrows the host allowlist by the This Computer provider toggle", () => {
    const on = { asciiBox: true, selfHostedVps: false, localVm: true, localMac: true };
    const off = { ...on, localMac: false };
    // No provider record yet: the legacy allowlist is the whole answer.
    expect(hostAwareAllowedComputers(null, undefined)).toBeNull();
    expect(hostAwareAllowedComputers(["cloud", "local"], undefined)).toEqual(["cloud", "local"]);
    // Provider on: unchanged.  Provider off: Local drops even when the legacy
    // allowlist is unrestricted, the same rule resolveGrants applies.
    expect(hostAwareAllowedComputers(null, on)).toBeNull();
    expect(hostAwareAllowedComputers(null, off)).toEqual(["cloud", "vm"]);
    expect(hostAwareAllowedComputers(["cloud", "local"], off)).toEqual(["cloud"]);
    // A provider record without the key reads as off (fail-closed).
    expect(hostAwareAllowedComputers(null, { asciiBox: true })).toEqual(["cloud", "vm"]);
    // The legacy allowlist still wins when it already blocks Local.
    expect(hostAwareAllowedComputers(["cloud"], on)).toEqual(["cloud"]);
  });

  it("sees flipping only localMac false->true as a new automatic host grant", () => {
    const darwin = { hostPlatform: "darwin", providerSupportsLocal: true };
    const providers = { asciiBox: true, selfHostedVps: false, localVm: true, localMac: false };
    const before = hostAwareAllowedComputers(null, providers);
    const after = hostAwareAllowedComputers(null, { ...providers, localMac: true });
    expect(requiresLocalAutoConsent(undefined, [], before, darwin)).toBe(false);
    expect(requiresLocalAutoConsent(undefined, [], after, darwin)).toBe(true);
  });
});
