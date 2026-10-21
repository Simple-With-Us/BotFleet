import { describe, expect, it, vi } from "vitest";
import { ControlConflict, createSystemControl, reserveSystemShutdown } from "./system-control.ts";

const targets = [{ key: "shared", label: "Shared" }, { key: "bot:a", label: "Bot A" }];
function fixture() {
  const states = new Map([["shared", "running"], ["bot:a", "running"]]);
  let busy = false;
  let owner: string | undefined;
  const action = vi.fn(async (kind: "stop" | "run" | "start", target: (typeof targets)[number]) => {
    states.set(target.key, kind === "stop" ? "stopped" : "running");
  });
  const control = createSystemControl({
    targets: () => targets,
    status: async (target) => ({ container: states.get(target.key) ?? "missing" }),
    owner: () => owner,
    busy: () => busy,
    action,
    afterStop: vi.fn(),
  });
  return { control, action, states, setBusy: (value: boolean) => { busy = value; }, setOwner: (value?: string) => { owner = value; } };
}

describe("system control", () => {
  it("fences new work before VM inspection and restores admission on failure", async () => {
    const f = fixture();
    let admitting = true;
    let enteredInspection = false;
    let releaseInspection!: () => void;
    const pause = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const reservation = reserveSystemShutdown({
      guard: () => f.control.guard(),
      activeWorkCount: () => 0,
      fence: () => { admitting = false; },
      unfence: () => { admitting = true; },
    });
    const inspect = async () => {
      enteredInspection = true;
      await pause;
      if (admitting) f.setBusy(true);
      await f.control.stopAll();
    };
    const running = inspect();
    expect(enteredInspection).toBe(true);
    expect(admitting).toBe(false);
    releaseInspection();
    await running;
    reservation.release();
    expect(admitting).toBe(true);
  });

  it("refuses other admitted work without raising a shutdown fence", () => {
    const fence = vi.fn();
    expect(() => reserveSystemShutdown({
      guard: () => {}, activeWorkCount: () => 1, fence, unfence: () => {},
    })).toThrow(ControlConflict);
    expect(fence).not.toHaveBeenCalled();
  });

  it("refuses active work before touching a VM", async () => {
    const f = fixture();
    f.setBusy(true);
    await expect(f.control.stopAll()).rejects.toBeInstanceOf(ControlConflict);
    expect(f.action).not.toHaveBeenCalled();
    f.setBusy(false);
    f.setOwner("bot-a");
    await expect(f.control.stopAll()).rejects.toBeInstanceOf(ControlConflict);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("stops shared and per-bot VMs without removing disks", async () => {
    const f = fixture();
    await expect(f.control.stopAll()).resolves.toEqual({ stopped: true });
    expect(f.action.mock.calls.map(([kind, target]) => [kind, target.key])).toEqual([
      ["stop", "shared"], ["stop", "bot:a"],
    ]);
  });

  it("does not resume an existing stopped desktop", async () => {
    const f = fixture();
    f.states.set("shared", "stopped");
    await expect(f.control.startShared()).rejects.toThrow(/Recreate it in Computer settings/);
    expect(f.action).not.toHaveBeenCalled();
  });

  it("starts a never-started shared VM without recreating it", async () => {
    const f = fixture();
    f.states.set("shared", "created");
    await expect(f.control.startShared()).resolves.toMatchObject({ key: "shared", running: true });
    expect(f.action.mock.calls.map(([kind]) => kind)).toEqual(["start"]);
  });

  it("reports a partial stop failure", async () => {
    const f = fixture();
    f.action.mockImplementationOnce(async () => { throw new Error("runtime unavailable"); });
    await expect(f.control.stopAll()).rejects.toThrow(/Shared: runtime unavailable/);
    expect(f.action).toHaveBeenCalledTimes(2);
  });

  it("re-checks admission between VM targets", async () => {
    const f = fixture();
    f.action.mockImplementationOnce(async (_kind, target) => {
      f.states.set(target.key, "stopped");
      f.setBusy(true);
    });
    await expect(f.control.stopAll()).rejects.toBeInstanceOf(ControlConflict);
    expect(f.action).toHaveBeenCalledTimes(1);
    expect(f.states.get("bot:a")).toBe("running");
  });

  it("reads every target in one shared pass when the caller can batch it", async () => {
    const status = vi.fn(async (_target: (typeof targets)[number]) => ({ container: "running" }));
    const statusAll = vi.fn(async (list: (typeof targets)[number][]) =>
      new Map(list.map((target) => [target.key, { container: "running" }])));
    const control = createSystemControl({
      targets: () => targets,
      status,
      statusAll,
      owner: () => undefined,
      busy: () => false,
      action: vi.fn(async () => {}),
      afterStop: vi.fn(),
    });

    await expect(control.list()).resolves.toEqual([
      { key: "shared", name: "Shared", running: true, state: "running" },
      { key: "bot:a", name: "Bot A", running: true, state: "running" },
    ]);
    expect(statusAll).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("falls back to the per-target read for a target the shared pass did not answer", async () => {
    const status = vi.fn(async (target: (typeof targets)[number]) =>
      ({ container: target.key === "bot:a" ? "stopped" : "running" }));
    const control = createSystemControl({
      targets: () => targets,
      status,
      statusAll: async (list) => new Map([[list[0]!.key, { container: "running" }]]),
      owner: () => undefined,
      busy: () => false,
      action: vi.fn(async () => {}),
      afterStop: vi.fn(),
    });

    await expect(control.list()).resolves.toEqual([
      { key: "shared", name: "Shared", running: true, state: "running" },
      { key: "bot:a", name: "Bot A", running: false, state: "stopped" },
    ]);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(targets[1]);
  });
});
