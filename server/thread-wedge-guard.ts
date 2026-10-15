import { isMcodeLockContentionMessage } from "./mcode-lock-contention.ts";

/** Consecutive no-output wedge failures before the harness rotates the task. */
export const THREAD_WEDGE_NO_OUTPUT_THRESHOLD = 5;

export interface ThreadWedgeKey {
  botId: string;
  threadId: string;
  instanceId: string;
}

const NO_OUTPUT_STOPS = new Set([
  "prompt_stall",
  "prompt_timeout",
  "exit_before_result",
  "resume_failed",
  "rpc_error",
]);

export function isNoOutputWedgeStop(stopReason: string | null | undefined): boolean {
  if (!stopReason) return false;
  return NO_OUTPUT_STOPS.has(stopReason);
}

function wedgeKey(key: ThreadWedgeKey): string {
  return `${key.botId}:${key.threadId}:${key.instanceId}`;
}

/** Tracks consecutive wedge-shaped failures per bot/thread/engine instance. */
export class ThreadWedgeGuard {
  private readonly streaks = new Map<string, number>();

  recordSuccess(key: ThreadWedgeKey): void {
    this.streaks.delete(wedgeKey(key));
  }

  recordFailure(
    key: ThreadWedgeKey,
    input: { stopReason?: string | null; runtimeMessage?: string },
  ): { streak: number; shouldRotate: boolean } {
    const wedge =
      isNoOutputWedgeStop(input.stopReason) ||
      (input.runtimeMessage ? isMcodeLockContentionMessage(input.runtimeMessage) : false);
    if (!wedge) {
      this.streaks.delete(wedgeKey(key));
      return { streak: 0, shouldRotate: false };
    }
    const id = wedgeKey(key);
    const streak = (this.streaks.get(id) ?? 0) + 1;
    this.streaks.set(id, streak);
    return { streak, shouldRotate: streak >= THREAD_WEDGE_NO_OUTPUT_THRESHOLD };
  }

  peek(key: ThreadWedgeKey): number {
    return this.streaks.get(wedgeKey(key)) ?? 0;
  }
}
