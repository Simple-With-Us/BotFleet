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
 * How long the enter and return animations are assumed to run.
 *
 * This is a contract with the asset pack, not a rendering detail: a correctly
 * generated ~600ms enter freezes on its last frame for the remainder, because
 * the player waits a fixed time before swapping to the hold. Whoever
 * regenerates the pack must hold enter and return to this duration.
 *
 * Urgent expressions skip the enter/return window entirely (see
 * `TVFACE_URGENT` / `planFrame`) so a 1–4s delay never blocks an error or
 * approval cue.  `transitionSpeed` scales the wait without re-encoding.
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
   * `scripts/tv-face-retime-gifs.py` if hold speed must change.
   */
  transitionSpeed?: number;
}

/**
 * Skins whose art ships under public/tv-face/skins.  Orange is the default
 * pack (directory name `default`).  Every other BotColor that has a folder
 * is listed here; unlisted colors fall back to default so they never 404.
 *
 * Asserted against the real directory listing in tvFaceSkins.test.ts.
 * Packs: blue green purple pink red cyan yellow teal coral (enter/return = 1000ms).
 * Build with scripts/tv-face-build-color-skins.py or scripts/tv-face-fetch-skins.sh.
 */

export const SHIPPED_SKINS: ReadonlySet<TVFaceSkin> = new Set<TVFaceSkin>([
  "orange",
  "blue",
  "green",
  "purple",
  "pink",
  "red",
  "cyan",
  "yellow",
  "teal",
  "coral",
]);

/** The skins directory a color renders from.  `orange` IS the default skin. */
export function tvFaceSkinDir(color: TVFaceSkin): string {
  if (color === "orange" || color === "default") return "default";
  return SHIPPED_SKINS.has(color) ? color : "default";
}

export interface TVFaceFrame {
  expression: TVFaceExpression;
  skin: string;
}

/** A replay is owed when the frame actually changed: a new expression, OR
 * the same expression under a different skin. The asset path embeds the
 * skin, so a color swap with an unchanged expression still needs a fresh
 * GIF — tracking only the expression leaves the old skin's image on
 * screen. */
export function tvFaceFrameChanged(prev: TVFaceFrame, next: TVFaceFrame): boolean {
  return prev.expression !== next.expression || prev.skin !== next.skin;
}

export type FrameStep = {
  expression: TVFaceExpression;
  kind: "enter" | "hold" | "return" | "still";
  /** Delay before the NEXT step, in ms. 0 on the final step. */
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
  // Returning home is never urgent — keep full return for polish unless
  // planFrame's interrupt path skipped the return entirely.
  void kind;
  const s = Math.max(0.25, speed);
  return Math.round(TVFACE_TRANSITION_MS / s);
}

/**
 * The sequence of assets to play when moving from one expression to another.
 *
 * Extracted from the component's effect so it is testable at all — the logic
 * previously lived inside a useEffect interleaved with setTimeout and could
 * only be exercised by rendering the component.
 *
 * `interrupt` (main) skips enter/return when either side is urgent, and can
 * be forced false to play enter despite an urgent target.  `speed` (skins
 * branch) scales the enter/return wait without re-encoding GIFs.
 */
export type PlanFrameOpts = { interrupt?: boolean; speed?: number };

export function planFrame(
  prev: TVFaceExpression,
  next: TVFaceExpression,
  opts: PlanFrameOpts = {},
): FrameStep[] {
  const speed = opts.speed ?? 1;
  const interrupt =
    opts.interrupt ?? (TVFACE_URGENT.has(prev) || TVFACE_URGENT.has(next));

  if (prev === next) {
    return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
  }

  if (next === RESTING) {
    // Return sequence: play the leaving expression's return, then land on the
    // resting still. Skipped when the expression has none or the cut is urgent.
    if (!TVFACE_HAS_ENTER_RETURN.has(prev) || interrupt) {
      return [{ expression: RESTING, kind: "still", delayAfterMs: 0 }];
    }
    return [
      { expression: prev, kind: "return", delayAfterMs: transitionDelayMs("return", RESTING, speed) },
      { expression: RESTING, kind: "still", delayAfterMs: 0 },
    ];
  }

  if (prev === RESTING) {
    if (!TVFACE_HAS_ENTER_RETURN.has(next) || interrupt) {
      return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
    }
    return [
      { expression: next, kind: "enter", delayAfterMs: transitionDelayMs("enter", next, speed) },
      { expression: next, kind: "hold", delayAfterMs: 0 },
    ];
  }

  // State to state: no enter. The previous hold ends where it ends, and
  // `next`'s enter is anchored to resting, so playing it would pop.
  return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
}

function tvFaceAssetPath(
  skinDir: string,
  expr: TVFaceExpression,
  type: "enter" | "hold" | "return",
  animated: boolean,
  isStill = false,
): string {
  const base = `/tv-face/skins/${skinDir}`;
  if (isStill || !animated) {
    return `${base}/stills/${expr}.png`;
  }
  return `${base}/gifs/${expr}_${type}.gif`;
}

function imgKeyForStep(skinDir: string, step: FrameStep, holdEpoch: number): string {
  if (step.kind === "hold") {
    return `${skinDir}:${step.expression}:hold:${holdEpoch}`;
  }
  return `${skinDir}:${step.expression}:${step.kind}`;
}

function pathForStepMedia(skinDir: string, step: FrameStep, animated: boolean): string {
  if (step.kind === "still") return tvFaceAssetPath(skinDir, step.expression, "hold", animated, true);
  return tvFaceAssetPath(skinDir, step.expression, step.kind, animated);
}

/** First paint must match the mount effect's first frame so `key` does not flip. */
function initialFrameMedia(
  expression: TVFaceExpression,
  skinDir: string,
  animated: boolean,
  speed: number,
): { src: string; imgKey: string; holdEpoch: number } {
  if (!animated) {
    return {
      src: tvFaceAssetPath(skinDir, expression, "hold", false, true),
      imgKey: `${skinDir}:${expression}:still`,
      holdEpoch: 0,
    };
  }

  const prevFrame: TVFaceFrame = { expression: RESTING, skin: skinDir };
  const nextFrame: TVFaceFrame = { expression, skin: skinDir };

  if (tvFaceFrameChanged(prevFrame, nextFrame)) {
    const step = planFrame(prevFrame.expression, expression, { speed })[0];
    return {
      src: pathForStepMedia(skinDir, step, true),
      imgKey: imgKeyForStep(skinDir, step, step.kind === "hold" ? 1 : 0),
      holdEpoch: step.kind === "hold" ? 0 : 0,
    };
  }

  return {
    src: tvFaceAssetPath(skinDir, expression, "hold", true),
    imgKey: `${skinDir}:${expression}:hold:1`,
    holdEpoch: 1,
  };
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

  const initialFrame = useRef(initialFrameMedia(expression, skinDir, animated, transitionSpeed));
  const [currentGif, setCurrentGif] = useState(initialFrame.current.src);
  const [imgKey, setImgKey] = useState(initialFrame.current.imgKey);
  const holdEpochRef = useRef(initialFrame.current.holdEpoch);
  const previousFrame = useRef<TVFaceFrame>({ expression: RESTING, skin: skinDir });
  const prevSpeed = useRef<number>(transitionSpeed);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getAssetPath = (expr: TVFaceExpression, type: "enter" | "hold" | "return", isStill = false) =>
    tvFaceAssetPath(skinDir, expr, type, animated, isStill);

  const pathForStep = (step: FrameStep): string => pathForStepMedia(skinDir, step, animated);

  useEffect(() => {
    if (!animated) {
      const still = getAssetPath(expression, "hold", true);
      setCurrentGif(still);
      setImgKey(`${skinDir}:${expression}:still`);
      return;
    }

    const prev = previousFrame.current;
    // A speed-only change must re-plan the wait with the new delay: the
    // frame comparison below would otherwise compare the frame against
    // itself and skip planFrame, leaving the in-flight wait unscaled.
    const speedChanged = prevSpeed.current !== transitionSpeed;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (tvFaceFrameChanged(prev, { expression, skin: skinDir }) || speedChanged) {
      const steps = planFrame(prev.expression, expression, { speed: transitionSpeed });
      let i = 0;
      const advance = () => {
        const step = steps[i];
        const src = pathForStep(step);
        if (step.kind === "hold") {
          holdEpochRef.current += 1;
          setImgKey(imgKeyForStep(skinDir, step, holdEpochRef.current));
        } else {
          setImgKey(imgKeyForStep(skinDir, step, 0));
        }
        setCurrentGif(src);
        i += 1;
        if (i < steps.length) {
          timeoutRef.current = setTimeout(advance, steps[i - 1].delayAfterMs);
        }
      };
      advance();
    } else if (!currentGif) {
      holdEpochRef.current += 1;
      setImgKey(`${skinDir}:${expression}:hold:${holdEpochRef.current}`);
      setCurrentGif(getAssetPath(expression, "hold"));
    }

    previousFrame.current = { expression, skin: skinDir };
    prevSpeed.current = transitionSpeed;

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
        key={imgKey}
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
