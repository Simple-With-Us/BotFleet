import { useEffect, useRef, useState } from "react";
import { BotState, BotColor } from "@/lib/mascot";
import { TVFACE_MANIFEST, TVFACE_HAS_ENTER_RETURN, TVFaceExpression } from "./manifest";

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
 * picker's preview shows exactly what the bot will get. */
const SHIPPED_SKINS = new Set(["orange"]);

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

export function TVFaceAvatar({
  state = "idle",
  color = "orange",
  size = 44,
  label,
  animated = true,
}: TVFaceAvatarProps) {
  const expression = TVFACE_MANIFEST[state] || "resting";
  const skinDir = tvFaceSkinDir(color);
  
  const [currentGif, setCurrentGif] = useState<string>("");
  const previousFrame = useRef<TVFaceFrame>({ expression: "resting", skin: skinDir });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const getAssetPath = (expr: TVFaceExpression, type: "enter" | "hold" | "return", isStill = false) => {
    const base = `/tv-face/skins/${skinDir}`;
    if (isStill || !animated) {
      return `${base}/stills/${expr}.png`;
    }
    return `${base}/gifs/${expr}_${type}.gif`;
  };

  useEffect(() => {
    if (!animated) {
      setCurrentGif(getAssetPath(expression, "hold", true));
      return;
    }

    const prev = previousFrame.current;
    
    // Clear any existing transition
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const playSequence = async () => {
      // If going from something to something else
      if (prev.expression !== "resting" && expression === "resting" && TVFACE_HAS_ENTER_RETURN.has(prev.expression)) {
        // Return sequence
        setCurrentGif(getAssetPath(prev.expression, "return"));
        
        timeoutRef.current = setTimeout(() => {
          setCurrentGif(getAssetPath("resting", "hold", true)); // idle rests on a still or hold
        }, 1000); // approximate transition time
      } else if (prev.expression !== expression && TVFACE_HAS_ENTER_RETURN.has(expression)) {
        // Enter sequence
        setCurrentGif(getAssetPath(expression, "enter"));
        
        timeoutRef.current = setTimeout(() => {
          setCurrentGif(getAssetPath(expression, "hold"));
        }, 1000);
      } else {
        // Direct jump (hold loop)
        setCurrentGif(getAssetPath(expression, "hold"));
      }
    };

    if (tvFaceFrameChanged(prev, { expression, skin: skinDir })) {
      playSequence();
    } else if (!currentGif) {
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
