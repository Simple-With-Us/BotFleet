import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { denyReason } from "../companion/src/routes.ts";
import { HOST_ID_PATTERN, PLACEMENT_WIRE_VERSION, type HostId } from "../shared/placement.ts";
import { loadControllerEpoch, placementIdentityResponse, type PlacementIdentityDeps } from "./placement-identity.ts";

const hostId: HostId = "server:11111111-1111-4111-8111-111111111111";
const otherHostId: HostId = "mac:22222222-2222-4222-8222-222222222222";
const owner = { localOwner: true, fromCompanion: false, viaNamedTunnel: false };

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "bf-placement-identity-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("controller epoch persistence", () => {
  it("defaults to this host as controller at epoch 0 and persists it privately beside host-id", () => {
    const dir = fixture();
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: hostId, epoch: 0 });
    const path = join(dir, "placement-controller.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ controllerId: hostId, epoch: 0 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: hostId, epoch: 0 });
  });

  it("reads back a stored controller and epoch instead of the defaults", () => {
    const dir = fixture();
    writeFileSync(join(dir, "placement-controller.json"), JSON.stringify({ controllerId: otherHostId, epoch: 3 }));
    expect(loadControllerEpoch(dir, hostId)).toEqual({ controllerId: otherHostId, epoch: 3 });
  });

  it("preserves malformed state and refuses to reset the fence", () => {
    const dir = fixture();
    const path = join(dir, "placement-controller.json");
    for (const damaged of ["not json", JSON.stringify({ controllerId: "nope", epoch: 0 }), JSON.stringify({ controllerId: hostId, epoch: -1 }), JSON.stringify({ controllerId: hostId, epoch: 1.5 })]) {
      writeFileSync(path, damaged);
      expect(() => loadControllerEpoch(dir, hostId)).toThrow(/placement-controller is invalid/);
      expect(readFileSync(path, "utf8")).toBe(damaged);
    }
  });
});

describe("placement identity route boundary", () => {
  it("serves the PlacementIdentity shape with defaults to the local owner", () => {
    const controller = loadControllerEpoch(fixture(), hostId);
    const response = placementIdentityResponse(owner, { hostId, controller, platform: "linux" });
    expect(response).toEqual({
      status: 200,
      body: {
        hostId, controllerId: hostId, epoch: 0,
        version: PLACEMENT_WIRE_VERSION, platform: "linux", capabilities: ["shell"],
      },
    });
    // The native handshake checks this against its accepted placement
    // version, independently of the product version /api/health reports.
    expect(response.status === 200 && response.body.version).toBe("1");
    expect(HOST_ID_PATTERN.test(response.status === 200 ? response.body.controllerId : "")).toBe(true);
  });

  it("reports the same platform capabilities as host resources and the stored fence", () => {
    const controller = { controllerId: otherHostId, epoch: 3 };
    const mac = placementIdentityResponse(owner, { hostId, controller, platform: "darwin" });
    expect(mac.status === 200 && mac.body).toEqual({
      hostId, controllerId: otherHostId, epoch: 3,
      version: PLACEMENT_WIRE_VERSION, platform: "darwin", capabilities: ["shell", "macos", "desktop"],
    });
    const server = placementIdentityResponse(owner, { hostId, controller, platform: "linux" });
    expect(server.status === 200 && server.body.capabilities).toEqual(["shell"]);
  });

  it("refuses remote, companion and named-tunnel callers, mirroring host resources", () => {
    const deps: PlacementIdentityDeps = { hostId, controller: { controllerId: hostId, epoch: 0 }, platform: "linux" };
    for (const caller of [
      { localOwner: false, fromCompanion: false, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: true, viaNamedTunnel: false },
      { localOwner: true, fromCompanion: false, viaNamedTunnel: true },
    ]) expect(placementIdentityResponse(caller, deps).status).toBe(403);
    expect(denyReason({ method: "GET", path: "/api/placement/identity", authenticated: true })?.status).toBe(404);
    expect(placementIdentityResponse(owner, deps).status).toBe(200);
  });

  it("answers 501 on unsupported platforms, after the owner gate", () => {
    const deps: PlacementIdentityDeps = { hostId, controller: { controllerId: hostId, epoch: 0 }, platform: "win32" };
    expect(placementIdentityResponse(owner, deps).status).toBe(501);
    expect(placementIdentityResponse({ ...owner, fromCompanion: true }, deps).status).toBe(403);
  });
});
