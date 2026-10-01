import { useEffect, useRef, useState } from "react";
import { BotState, BotColor } from "@/lib/mascot";
import {
  TVFACE_HAS_ENTER_RETURN,
  TVFACE_MANIFEST,
  type TVFaceExpression,
} from "./manifest";

/** The expression an idle bot rests on. */
const RESTING: TVFaceExpression = "resting";

/**
 * How long the enter and return animations are assumed to run for a normal
 * transition.  This is a contract with the asset pack: enter/return GIFs must
 * sum to this duration (±20ms).  Whoever regenerates the pack must keep that.
 *
 * Urgent expressions skip the enter/return window entirely (see
 * `TVFACE_URGENT` / `planFrame`) so a 1–4s delay never blocks an error or
 * approval cue.
 */
export const TVFACE_TRANSITION_MS = 1000;

/**
 * Expressions that must land immediately — no enter, no return wait.
 * Inspired by OpenMausBot/CursorAvatar treatment of alerting (glyph bang,
 * high jitter): approval / error / crash / scare cues cut mid-animation so the
 * face is never "busy playing an intro" when the bot needs attention.
 *
 * Keep this set small.  Everyday work (thinking, typing) keeps full enter/return.
 */
export const TVFACE_URGENT: ReadonlySet<TVFaceExpression> = new Set([
  "alerting",
  "crash",
  "angry",
  "scared",
  "notifying",
]);

export type TVFaceSkin = BotColor | "default";

export interface TVFaceAvatarProps {
  state?: BotState;
  color?: TVFaceSkin;
  size?: number;
  label?: string;
  animated?: boolean;
  /**
   * Playback speed for transition GIFs only (enter/return).  1 = pack timing
   * (~1s).  >1 shortens the wait before hold (faster feel without re-encoding).
   * Hold GIFs always loop at their authored frame delays — browsers cannot
   * retarget GIF frame rate on an <img>; re-encode with
   * `scripts/tv-face-retime-gifs.mjs` if hold speed must change.
   */
  transitionSpeed?: number;
}

/**
 * Skins whose art ships under public/tv-face/skins.  Orange is the default
 * pack (directory name `default`).  Every other BotColor that has a folder
 * is listed here; unlisted colors fall back to default so they never 404.
 *
 * Asserted against the real directory listing in tvFaceSkins.test.ts.
 */
/** Expand this set when color packs are present under public/tv-face/skins/{color}.
 *  Build with scripts/tv-face-build-color-skins.py or fetch from FleetLink
 *  (scripts/tv-face-fetch-skins.sh).  Tests assert this set matches on-disk dirs. */
export const SHIPPED_SKINS: ReadonlySet<TVFaceSkin> = new Set<TVFaceSkin>(["orange"]);

/** The skins directory a color renders from.  `orange` IS the default skin. */
export function tvFaceSkinDir(color: TVFaceSkin): string {
  if (color === "orange" || color === "default") return "default";
  return SHIPPED_SKINS.has(color) ? color : "default";
}

export interface TVFaceFrame {
  expression: TVFaceExpression;
  skin: string;
}

/** A replay is owed when the frame actually changed. */
export function tvFaceFrameChanged(prev: TVFaceFrame, next: TVFaceFrame): boolean {
  return prev.expression !== next.expression || prev.skin !== next.skin;
}

export type FrameStep = {
  expression: TVFaceExpression;
  kind: "enter" | "hold" | "return" | "still";
  /** Delay before the NEXT step, in ms.  0 on the final step. */
  delayAfterMs: number;
};

export function isUrgentExpression(expr: TVFaceExpression): boolean {
  return TVFACE_URGENT.has(expr);
}

/**
 * Effective wait after an enter/return step.  Urgent targets get 0 so the
 * player can cut mid-animation.  `speed` scales the normal wait (2 → 500ms).
 */
export function transitionDelayMs(
  kind: "enter" | "return",
  next: TVFaceExpression,
  speed = 1,
): number {
  if (isUrgentExpression(next)) return 0;
  // Returning home is never urgent — keep full return for polish.
  if (kind === "return") {
    const s = Math.max(0.25, speed);
    return Math.round(TVFACE_TRANSITION_MS / s);
  }
  const s = Math.max(0.25, speed);
  return Math.round(TVFACE_TRANSITION_MS / s);
}

/**
 * Sequence of assets to play when moving from one expression to another.
 *
 * Rules (learned from the existing pop-fix + OpenMausBot alerting priority):
 * 1. Unchanged → hold (looping GIF; browser loops loop=0).
 * 2. To resting → return (if any) then resting still.
 * 3. From resting → enter (if any) then hold — unless target is urgent, then hold only.
 * 4. Active → active → cut to new hold (no enter; enter is resting-anchored).
 * 5. To an urgent expression from anywhere → cut straight to hold (interrupt).
 * 6. Leaving an in-progress enter/return is the component's job: any state
 *    change clears the timeout and re-plans (see the effect below).
 */
export function planFrame(
  prev: TVFaceExpression,
  next: TVFaceExpression,
  options?: { speed?: number },
): FrameStep[] {
  const speed = options?.speed ?? 1;

  if (prev === next) {
    return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
  }

  // Urgent destinations always interrupt — no return from prev, no enter into next.
  if (isUrgentExpression(next) && next !== RESTING) {
    return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
  }

  if (next === RESTING) {
    if (!TVFACE_HAS_ENTER_RETURN.has(prev)) {
      return [{ expression: RESTING, kind: "still", delayAfterMs: 0 }];
    }
    return [
      { expression: prev, kind: "return", delayAfterMs: transitionDelayMs("return", RESTING, speed) },
      { expression: RESTING, kind: "still", delayAfterMs: 0 }];
  }

  if (prev === RESTING) {
    if (!TVFACE_HAS_ENTER_RETURN.has(next)) {
      return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
    }
    return [
      { expression: next, kind: "enter", delayAfterMs: transitionDelayMs("enter", next, speed) },
      { expression: next, kind: "hold", delayAfterMs: 0 }];
  }

  // State to state: no enter (resting-anchored enter would pop).
  return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
}

export function TVFaceAvatar({
  state = "idle",
  color = "orange",
  size = 44,
  label,
  animated = true,
  transitionSpeed = 1,
}: TVFaceAvatarProps) {
  const expression = TVFACE_MANIFEST[state] || RESTING;
  const skinDir = tvFaceSkinDir(color);

  const [currentGif, setCurrentGif] = useState<string>("");
  const previousFrame = useRef<TVFaceFrame>({ expression: RESTING, skin: skinDir });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Cache-bust key so restarting a hold GIF always restarts its loop from frame 0. */
  const playGen = useRef(0);

  const getAssetPath = (
    expr: TVFaceExpression,
    type: "enter" | "hold" | "return",
    isStill = false,
  ) => {
    const base = `/tv-face/skins/${skinDir}`;
    if (isStill || !animated) {
      return `${base}/stills/${expr}.png`;
    }
    return `${base}/gifs/${expr}_${type}.gif`;
  };

  const pathForStep = (step: FrameStep): string => {
    if (step.kind === "still") return getAssetPath(step.expression, "hold", true);
    // Bust cache on every step so the browser restarts the GIF timeline
    // (critical for holds that must loop from the first frame, and for
    // interrupt/replay of the same URL after a mid-animation cut).
    playGen.current += 1;
    const path = getAssetPath(step.expression, step.kind);
    return `${path}?g=${playGen.current}`;
  };

  useEffect(() => {
    if (!animated) {
      setCurrentGif(getAssetPath(expression, "hold", true));
      return;
    }

    const prev = previousFrame.current;

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (tvFaceFrameChanged(prev, { expression, skin: skinDir })) {
      const steps = planFrame(prev.expression, expression, { speed: transitionSpeed });
      let i = 0;
      const advance = () => {
        const step = steps[i];
        setCurrentGif(pathForStep(step));
        i += 1;
        if (i < steps.length) {
          timeoutRef.current = setTimeout(advance, steps[i - 1].delayAfterMs);
        }
      };
      advance();
    } else if (!currentGif) {
      setCurrentGif(pathForStep({ expression, kind: "hold", delayAfterMs: 0 }));
    }

    previousFrame.current = { expression, skin: skinDir };

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // transitionSpeed intentionally included: changing it re-plans the wait.
  }, [expression, animated, color, skinDir, transitionSpeed]);

  return (
    <div
      className="inline-flex shrink-0 relative overflow-hidden"
      style={{ width: size, height: size }}
      title={label}
    >
      <img
        key={currentGif}
        src={currentGif}
        alt={label || `Bot ${expression} face`}
        className="w-full h-full object-contain"
        draggable={false}
        onError={(e) => {
          const target = e.currentTarget;
          const stillSrc = getAssetPath(expression, "hold", true);
          const restSrc = getAssetPath("resting", "hold", true);
          if (target.src.includes(".gif") && !target.src.includes(stillSrc)) {
            target.src = stillSrc;
          } else if (!target.src.includes(restSrc)) {
            target.src = restSrc;
          }
        }}
      />
    </div>
  );
}
