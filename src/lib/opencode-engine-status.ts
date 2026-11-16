import type { InstanceInfo } from "@/state/store";
import { humanizeOpenCodeModelProbeProblem } from "../../shared/opencode-model-probe.ts";

export function openCodeModelProbeSentence(instance: InstanceInfo | undefined): string | null {
  if (!instance || instance.driverKind !== "opencodeGo") return null;
  const raw = instance.snapshot.modelProbeProblem;
  if (!raw) return null;
  return humanizeOpenCodeModelProbeProblem(raw);
}

/** Short status chip when the full sentence is shown elsewhere. */
export function openCodeEngineStatusChip(instance: InstanceInfo): string | null {
  const sentence = openCodeModelProbeSentence(instance);
  if (!sentence) return null;
  if (/timed out/i.test(sentence)) return "Timed out under load";
  if (/listed no models/i.test(sentence) || /answered but listed no models/i.test(sentence)) {
    return "No models listed";
  }
  if (/stopped before/i.test(sentence)) return "Stopped early";
  return "Needs attention";
}
