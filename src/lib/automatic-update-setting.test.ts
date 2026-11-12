import { describe, expect, it, vi } from "vitest";

import { putAutomaticUpdateSetting } from "./automatic-update-setting";

describe("automatic update setting save", () => {
  it("rejects an HTTP error instead of treating its JSON as saved config", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "settings are locked" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(putAutomaticUpdateSetting(true, request)).rejects.toThrow("settings are locked");
    expect(request).toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ autoUpdate: { enabled: true } }) }),
    );
  });
});
