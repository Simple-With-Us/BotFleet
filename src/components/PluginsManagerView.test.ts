import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import {
  PluginListingSchema,
  PluginListingSourceSchema,
  PluginsResponseSchema,
  type PluginListing,
  type PluginListingSource,
  type PluginsResponse,
} from "../../server/plugin-types";

// The view's types are derived from the schemas that read the plugins route, so
// they cannot drift apart.  These checks pin that, and the one runtime behaviour
// the derivation chose: unknown fields are stripped at the boundary, so a field
// the server adds cannot blank the list.

const listing = {
  name: "weather",
  version: "1.2.0",
  description: "Shows the weather",
  botfleet: ">=1.0.0",
  entry: "index.mjs",
  enabled: true,
  installedAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  source: { kind: "folder" as const, path: "/plugins/weather" },
  warnings: [],
  capabilities: ["read.bots"],
};

describe("plugins manager schemas", () => {
  it("derives the view types from the schemas", () => {
    expectTypeOf<PluginListing>().toEqualTypeOf<z.infer<typeof PluginListingSchema>>();
    expectTypeOf<PluginsResponse>().toEqualTypeOf<z.infer<typeof PluginsResponseSchema>>();
    expectTypeOf<PluginListingSource>().toEqualTypeOf<z.infer<typeof PluginListingSourceSchema>>();
    // A folder source always has a path, and a git source always has a url: the old
    // hand-written interface made both optional on both kinds.
    expectTypeOf<Extract<PluginListingSource, { kind: "folder" }>["path"]>().toEqualTypeOf<string>();
    expectTypeOf<Extract<PluginListingSource, { kind: "git" }>["url"]>().toEqualTypeOf<string>();
  });

  it("silently drops a field the server adds instead of rejecting it", () => {
    const parsed = PluginsResponseSchema.safeParse({
      plugins: [{ ...listing, addedLater: true, source: { ...listing.source, extra: 1 } }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const parsedListing = parsed.data.plugins[0]!;
    expect("addedLater" in parsedListing).toBe(false);
    expect("extra" in parsedListing.source).toBe(false);
  });

  it("rejects a listing whose source cannot be shown", () => {
    expect(PluginListingSourceSchema.safeParse({ kind: "folder" }).success).toBe(false);
    expect(PluginListingSourceSchema.safeParse({ kind: "git" }).success).toBe(false);
    expect(PluginsResponseSchema.safeParse({ plugins: [{ ...listing, source: { kind: "git" } }] }).success).toBe(false);
  });
});