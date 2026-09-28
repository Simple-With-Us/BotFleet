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

const AVAILABLE_SKINS = new Set(["orange", "blue", "green", "purple", "pink", "red", "yellow"]);

export function TVFaceAvatar({
  state = "idle",
  color = "orange",
  size = 44,
  label,
  animated = true,
}: TVFaceAvatarProps) {
  const expression = TVFACE_MANIFEST[state] || "resting";
  // fallback to orange if the color isn't one of the known skins
  const mappedColor = AVAILABLE_SKINS.has(color) ? color : "orange";
  const skinDir = mappedColor === "orange" ? "default" : mappedColor;
  
  const [currentGif, setCurrentGif] = useState<string>("");
  const previousExpression = useRef<TVFaceExpression>("resting");
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

    const prev = previousExpression.current;
    
    // Clear any existing transition
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const playSequence = async () => {
      // If going from something to something else
      if (prev !== "resting" && expression === "resting" && TVFACE_HAS_ENTER_RETURN.has(prev)) {
        // Return sequence
        setCurrentGif(getAssetPath(prev, "return"));
        
        timeoutRef.current = setTimeout(() => {
          setCurrentGif(getAssetPath("resting", "hold", true)); // idle rests on a still or hold
        }, 1000); // approximate transition time
      } else if (prev !== expression && TVFACE_HAS_ENTER_RETURN.has(expression)) {
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

    if (prev !== expression) {
      playSequence();
    } else if (!currentGif) {
      setCurrentGif(getAssetPath(expression, "hold"));
    }

    previousExpression.current = expression;

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
      />
    </div>
  );
}
