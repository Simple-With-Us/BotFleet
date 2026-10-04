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
 */
export const TVFACE_TRANSITION_MS = 1000;

/** Expressions that should cut in/out instantly — no enter/return dwell. */
export const TVFACE_URGENT: ReadonlySet<TVFaceExpression> = new Set([
  "crash",
  "alerting",
  "angry",
]);

export type TVFaceSkin = BotColor | "default";

export interface TVFaceAvatarProps {
  state?: BotState;
  color?: TVFaceSkin;
  size?: number;
  label?: string;
  animated?: boolean;
}

/** Skins whose art actually ships under public/tv-face/skins. Blue, green,
 * purple, pink, red, and yellow are PLANNED skins with no assets yet:
 * mapping them to their own directories 404s every GIF and still. Until
 * the art lands, every color renders the default skin — and the profile
 * picker's preview shows exactly what the bot will get.
 *
 * This was previously INVERTED: it named exactly the six skins whose
 * directories did not exist, so a bot set to blue built a 404 path. It is
 * asserted against the real directory listing in tvFaceSkins.test.ts, because
 * a hand-maintained whitelist next to a hand-maintained directory listing is
 * how it drifted in the first place. */
export const SHIPPED_SKINS: ReadonlySet<TVFaceSkin> = new Set<TVFaceSkin>(["orange"]);

/** The skins directory a color renders from. `orange` IS the default skin
 * (public/tv-face/skins/default); every unshipped color falls back to it
 * rather than 404ing. */
export function tvFaceSkinDir(color: TVFaceSkin): string {
  return SHIPPED_SKINS.has(color) && color !== "orange" ? color : "default";
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

/**
 * The sequence of assets to play when moving from one expression to another.
 *
 * Extracted from the component's effect so it is testable at all — the logic
 * previously lived inside a useEffect interleaved with setTimeout and could
 * only be exercised by rendering the component.
 *
 * The back-to-back case is the important one. The asset guidelines anchor
 * every `_enter` to resting.png, but a preceding `_hold` ends wherever it
 * ends, so playing an enter on a state-to-state change pops visibly. With
 * enter and return now on all 15 expressions that would happen on EVERY
 * transition, so a change between two active states cuts straight to the new
 * hold: enter only from rest, return only to rest.
 */
export type PlanFrameOpts = { interrupt?: boolean };

export function planFrame(
  prev: TVFaceExpression,
  next: TVFaceExpression,
  opts: PlanFrameOpts = {},
): FrameStep[] {
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
      { expression: prev, kind: "return", delayAfterMs: TVFACE_TRANSITION_MS },
      { expression: RESTING, kind: "still", delayAfterMs: 0 },
    ];
  }

  if (prev === RESTING) {
    if (!TVFACE_HAS_ENTER_RETURN.has(next) || interrupt) {
      return [{ expression: next, kind: "hold", delayAfterMs: 0 }];
    }
    return [
      { expression: next, kind: "enter", delayAfterMs: TVFACE_TRANSITION_MS },
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
    const step = planFrame(prevFrame.expression, expression)[0];
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
}: TVFaceAvatarProps) {
  const expression = TVFACE_MANIFEST[state] || RESTING;
  const skinDir = tvFaceSkinDir(color);

  const initialFrame = useRef(initialFrameMedia(expression, skinDir, animated));
  const [currentGif, setCurrentGif] = useState(initialFrame.current.src);
  const [imgKey, setImgKey] = useState(initialFrame.current.imgKey);
  const holdEpochRef = useRef(initialFrame.current.holdEpoch);
  const previousFrame = useRef<TVFaceFrame>({ expression: RESTING, skin: skinDir });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

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

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    if (tvFaceFrameChanged(prev, { expression, skin: skinDir })) {
      const steps = planFrame(prev.expression, expression);
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

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [expression, animated, color]);

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
          if (target.src.includes(".gif") && !target.src.endsWith(stillSrc)) {
            target.src = stillSrc;
          } else if (!target.src.endsWith(restSrc)) {
            target.src = restSrc;
          }
        }}
      />
    </div>
  );
}
