import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { botSupportsImageAttachments, selectedModelSupportsImages } from "./model-images";

const instance = (images: boolean, options: Array<{ id: string; label: string; images?: boolean }>): InstanceInfo => ({
  instanceId: "dsh", driverKind: "dshAgent", displayName: "Harness",
  snapshot: { state: "available" }, models: { default: "Flash", options },
  capabilities: { images },
} as InstanceInfo);
const bot = (model: string, taskModel?: string): Bot => ({
  id: "bot", threadId: "current", modelSelection: { instanceId: "dsh", model },
  tasks: taskModel ? [{ threadId: "current", title: "Current", createdAt: 1, modelSelection: { instanceId: "dsh", model: taskModel } }] : [],
} as Bot);

describe("per-model image attachment gate", () => {
  const catalog = [
    { id: "Flash", label: "Flash", images: true },
    { id: "Pro", label: "Pro", images: false },
    { id: "Unknown", label: "Unknown" },
  ];

  it("uses an explicit model flag before the engine flag", () => {
    const instances = [instance(true, catalog)];
    expect(botSupportsImageAttachments(instances, bot("Flash"))).toBe(true);
    expect(botSupportsImageAttachments(instances, bot("Pro"))).toBe(false);
    expect(botSupportsImageAttachments([instance(false, catalog)], bot("Flash"))).toBe(true);
  });

  it("inherits the engine flag only for a model without an explicit flag", () => {
    expect(botSupportsImageAttachments([instance(true, catalog)], bot("Unknown"))).toBe(true);
    expect(botSupportsImageAttachments([instance(false, catalog)], bot("Unknown"))).toBe(false);
    expect(selectedModelSupportsImages([instance(true, catalog)], { instanceId: "dsh", model: "missing" })).toBe(true);
    expect(selectedModelSupportsImages([], { instanceId: "dsh", model: "Flash" })).toBe(false);
    expect(selectedModelSupportsImages([instance(true, catalog)], undefined)).toBe(false);
  });

  it("keeps the current bot's selected instance separate from another instance", () => {
    const other = { ...instance(true, catalog), instanceId: "other", models: {
      default: "Pro", options: [{ id: "Pro", label: "Pro", images: true }],
    } };
    expect(botSupportsImageAttachments([instance(true, catalog), other], bot("Pro"))).toBe(false);
    expect(selectedModelSupportsImages([instance(true, catalog), other], { instanceId: "other", model: "Pro" })).toBe(true);
  });

  it("uses the current task's model override, not an unrelated default or older task", () => {
    const instances = [instance(true, catalog)];
    expect(botSupportsImageAttachments(instances, bot("Flash", "Pro"))).toBe(false);
    expect(botSupportsImageAttachments(instances, bot("Pro", "Flash"))).toBe(true);
    const otherTask = bot("Pro", "Flash");
    otherTask.tasks![0]!.threadId = "older";
    expect(botSupportsImageAttachments(instances, otherTask)).toBe(false);
  });

  it("requires every actual room responder to support images", () => {
    const instances = [instance(true, catalog)];
    const responders = [bot("Flash"), bot("Pro")];
    expect(responders.every((candidate) => botSupportsImageAttachments(instances, candidate))).toBe(false);
    expect(responders.slice(0, 1).every((candidate) => botSupportsImageAttachments(instances, candidate))).toBe(true);
  });
});
