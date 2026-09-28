// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. The moment there is an answer, the label is gone and
// the full bubble pops in above the mascot (same left edge).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function TurnPresence({
  startedAt,
  avatar,
  visible,
  label = "Thinking",
  answering = false,
  modelMark,
  modelName,
  actorName,
  children,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  modelMark?: ReactNode;
  modelName?: string;
  actorName?: string;
  startedAt?: number;
  children?: ReactNode;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (visible && phase === "think") {
      const start = startedAt ?? Date.now();
      setElapsed(Math.max(1, Math.floor((Date.now() - start) / 1000)));
      const timer = setInterval(() => {
        setElapsed(Math.max(1, Math.floor((Date.now() - start) / 1000)));
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [visible, phase, startedAt]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const showAnswer = phase === "answer" && children;
  const showWorking = phase === "think";
  return (
    <div className="turn-presence flex flex-col items-start">
      {showAnswer ? <div className="turn-answer">{children}</div> : null}
      <div
        className={cn(
          "flex items-center gap-2",
          showAnswer && "turn-mascot-tight",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {showWorking ? (
          <span className="flex items-center gap-2" aria-live="polite">
            {actorName ? (
              <span className="text-[13px] font-semibold text-ink">
                {actorName}
              </span>
            ) : null}
            <span className="thinking-shimmer animate-shimmer text-[13px] leading-none">
              {label}{elapsed > 0 ? ` · ${elapsed}s` : ""}
            </span>
            {modelName ? (
              <span className="flex items-center gap-1.5 text-[12px] leading-none text-ink-secondary">
                {modelMark}
                <span className="italic">{modelName}</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}
