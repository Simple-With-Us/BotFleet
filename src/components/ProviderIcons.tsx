import codexMark from "/codex-mark.png";
import antigravityMark from "/antigravity-mark.png";
import deepseekMark from "/deepseek-mark.png";
import claudeMark from "/claude-mark.png";
import grokMark from "/grok-mark.png";
// Provider brand marks, keyed by driver kind. Official logos only.
import { Monitor } from "lucide-react";
import { cn } from "@/lib/cn";
import { HermesMark } from "./HermesMark";
import { CursorMark } from "./CursorMark";

export { HermesMark, CursorMark };

export interface IconProps {
  size?: number;
  className?: string;
}

export function GrokMark({ size = 16, className }: IconProps) {
  return (
    <img
      src={grokMark}
      width={size}
      height={size}
      className={cn("object-contain dark:invert", className)}
      alt="Grok"
      aria-hidden
    />
  );
}

export function DeepSeekMark({ size = 16, className }: IconProps) {
  return (
    <img
      src={deepseekMark}
      width={size}
      height={size}
      className={cn("object-contain", className)}
      alt="DeepSeek"
      aria-hidden
    />
  );
}

export function ClaudeMark({ size = 16, className }: IconProps) {
  return (
    <img
      src={claudeMark}
      width={size}
      height={size}
      className={cn("object-contain", className)}
      alt="Claude"
      aria-hidden
    />
  );
}

export function CodexMark({ size = 16, className }: IconProps) {
  return (
    <img 
      src={codexMark} 
      width={size} 
      height={size} 
      className={cn("object-contain", className)} 
      alt="Codex"
      aria-hidden
    />
  );
}

/** Official Google Antigravity mark using the Gemini 4-point star logo */
export function AntigravityMark({ size = 16, className }: IconProps) {
  return (
    <img 
      src={antigravityMark} 
      width={size} 
      height={size} 
      className={cn("object-contain", className)} 
      alt="Antigravity"
      aria-hidden
    />
  );
}

export const GeminiMark = AntigravityMark;

export function ComputerMark({ size = 16, className }: IconProps) {
  return <Monitor size={size} className={cn("text-ink-secondary", className)} />;
}

/** Official Kimi mark (Moonshot). */
export function KimiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden>
      <path
        d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"
        fill="#1783FF"
      />
      <path
        d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"
        fill="var(--color-ink)"
      />
    </svg>
  );
}

/** Official Factory Droid mark (factory.ai favicon). */
export function DroidMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 508 508" className={className} aria-hidden>
      <path
        fill="var(--color-ink)"
        d="M321.997 150.712C321.401 150.568 320.844 150.299 320.363 149.925C319.883 149.551 319.491 149.08 319.215 148.544C318.938 148.008 318.783 147.42 318.76 146.821C318.738 146.22 318.848 145.624 319.084 145.07C327.226 125.716 330.819 110.23 325.021 103.747C309.666 86.5471 248.085 120.749 228.451 132.333C227.925 132.642 227.337 132.837 226.728 132.903C226.118 132.969 225.501 132.906 224.918 132.719C224.336 132.531 223.801 132.223 223.351 131.815C222.902 131.407 222.548 130.909 222.313 130.356C214.06 111.043 205.384 97.6094 196.589 97.0268C173.279 95.4688 154.491 162.187 148.991 183.932C148.844 184.515 148.57 185.06 148.188 185.528C147.805 185.998 147.323 186.381 146.775 186.651C146.227 186.921 145.626 187.072 145.012 187.094C144.399 187.116 143.788 187.009 143.221 186.778C123.406 178.825 107.545 175.316 100.914 180.98C83.305 195.978 118.315 256.126 130.175 275.304C130.492 275.816 130.692 276.391 130.76 276.987C130.829 277.582 130.765 278.186 130.573 278.755C130.381 279.325 130.065 279.847 129.647 280.286C129.228 280.725 128.718 281.07 128.15 281.298C108.384 289.359 94.6306 297.834 94.0272 306.424C92.439 329.192 160.74 347.544 183.01 352.916C183.605 353.061 184.16 353.33 184.64 353.704C185.118 354.077 185.509 354.548 185.785 355.083C186.061 355.618 186.215 356.205 186.237 356.803C186.26 357.402 186.151 357.998 185.916 358.551C177.773 377.905 174.181 393.398 179.979 399.874C195.334 417.074 256.921 382.877 276.556 371.293C277.081 370.984 277.67 370.789 278.28 370.722C278.889 370.655 279.507 370.717 280.09 370.905C280.673 371.093 281.207 371.402 281.657 371.81C282.106 372.219 282.46 372.717 282.694 373.271C290.947 392.578 299.616 406.012 308.417 406.601C331.728 408.153 350.516 341.44 356.009 319.688C356.157 319.106 356.432 318.562 356.816 318.094C357.2 317.625 357.682 317.243 358.231 316.974C358.779 316.705 359.381 316.554 359.995 316.533C360.608 316.511 361.219 316.619 361.786 316.85C381.601 324.803 397.455 328.304 404.093 322.648C421.702 307.65 386.684 247.495 374.825 228.317C374.51 227.804 374.312 227.229 374.245 226.634C374.177 226.039 374.242 225.436 374.434 224.868C374.626 224.299 374.941 223.777 375.358 223.338C375.775 222.899 376.284 222.552 376.85 222.323C376.85 222.323 376.85 222.323 376.85 222.323ZM295.254 128.885C299.734 136.73 276.646 189 259.474 225.561C259.186 226.172 258.715 226.682 258.121 227.024C257.528 227.365 256.842 227.521 256.155 227.47C255.468 227.419 254.814 227.164 254.28 226.739C253.746 226.314 253.358 225.739 253.169 225.093C246.234 201.322 238.306 173.392 229.824 149.683C229.491 148.752 229.508 147.736 230.871 146.817C230.235 145.897 230.921 145.133 231.808 144.662C252.989 133.363 289.234 118.358 295.254 128.885ZM193.746 135.355C202.589 137.807 224.103 190.714 238.424 228.426C238.664 229.056 238.699 229.742 238.527 230.393C238.354 231.044 237.983 231.627 237.461 232.065C236.939 232.503 236.292 232.775 235.608 232.844C234.923 232.913 234.234 232.775 233.632 232.45C211.501 220.453 185.694 206.159 162.529 195.253C161.622 194.823 160.901 194.093 160.493 193.192C160.085 192.292 160.018 191.279 160.303 190.335C167.12 167.736 181.865 132.069 193.746 135.355ZM126.652 210.04C134.676 205.664 188.197 228.216 225.621 244.989C226.248 245.269 226.771 245.73 227.12 246.31C227.47 246.889 227.629 247.56 227.577 248.23C227.524 248.901 227.264 249.54 226.828 250.062C226.393 250.582 225.805 250.962 225.143 251.147C200.813 257.921 172.211 265.664 147.937 273.949C146.985 274.272 145.946 274.255 145.007 273.9C144.067 273.545 143.286 272.876 142.805 272.011C131.257 251.322 115.867 215.92 126.652 210.04ZM133.275 309.188C135.779 300.551 189.952 279.537 228.562 265.548C229.207 265.315 229.91 265.28 230.576 265.448C231.243 265.617 231.84 265.98 232.288 266.49C232.736 266.999 233.015 267.631 233.085 268.299C233.155 268.968 233.015 269.641 232.682 270.23C220.392 291.846 205.758 317.053 194.592 339.672C194.156 340.561 193.409 341.269 192.486 341.668C191.563 342.068 190.525 342.134 189.557 341.853C166.42 335.235 129.905 320.792 133.275 309.188ZM209.739 374.722C205.252 366.884 228.347 314.608 245.519 278.054C245.806 277.442 246.279 276.931 246.872 276.59C247.465 276.249 248.151 276.093 248.838 276.144C249.525 276.194 250.179 276.45 250.713 276.875C251.247 277.3 251.634 277.874 251.824 278.521C258.759 302.285 266.686 330.222 275.169 353.932C275.499 354.862 275.481 355.877 275.117 356.795C274.752 357.713 274.064 358.475 273.178 358.945C252.004 370.223 215.752 385.256 209.76 374.722H209.739ZM311.247 368.252C302.397 365.807 280.883 312.894 266.562 275.182C266.322 274.55 266.285 273.862 266.458 273.21C266.63 272.559 267.003 271.974 267.526 271.536C268.049 271.097 268.697 270.826 269.382 270.758C270.068 270.69 270.759 270.83 271.361 271.157C293.485 283.154 319.299 297.455 342.457 308.362C343.366 308.789 344.089 309.519 344.497 310.42C344.905 311.321 344.971 312.335 344.683 313.28C337.872 335.912 323.128 371.544 311.247 368.252ZM378.341 293.566C370.31 297.949 316.795 275.391 279.365 258.618C278.738 258.338 278.215 257.877 277.866 257.297C277.516 256.718 277.357 256.047 277.409 255.377C277.461 254.706 277.722 254.067 278.158 253.546C278.593 253.025 279.181 252.646 279.843 252.461C304.18 245.687 332.775 237.943 357.049 229.658C358.003 229.335 359.043 229.353 359.984 229.709C360.925 230.065 361.706 230.737 362.188 231.603C373.729 252.285 389.119 287.693 378.341 293.566ZM371.718 194.419C369.207 203.063 315.041 224.077 276.431 238.066C275.784 238.3 275.08 238.335 274.413 238.167C273.746 237.999 273.148 237.635 272.698 237.124C272.249 236.613 271.972 235.98 271.903 235.31C271.833 234.641 271.975 233.966 272.311 233.377C284.594 211.768 299.228 186.554 310.394 163.935C310.833 163.048 311.58 162.343 312.502 161.945C313.425 161.546 314.462 161.481 315.429 161.76C338.566 168.413 375.081 182.815 371.718 194.419Z"
      />
    </svg>
  );
}

/** Official OpenCode mark. */
export function OpenCodeMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden>
      <path fillRule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </svg>
  );
}

/** Official Qwen mark. */
export function QwenMark({ size = 16, className }: IconProps) {
  const grad = "omb-qwen-mark";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill={`url(#${grad})`}
        fillRule="nonzero"
        d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"
      />
      <defs>
        <linearGradient id={grad} x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stopColor="#6336E7" stopOpacity={0.92} />
          <stop offset="100%" stopColor="#6F69F7" stopOpacity={0.92} />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * MiniMax mark.  Authored here as a vector rather than dropped in as a PNG:
 * no official MiniMax raster ships with this repo, and the codex/cursor mark
 * mix-up (two files holding each other's artwork) is exactly what happens when
 * a binary nobody can read in a diff is trusted on its filename.  This is a
 * geometric mark, not the MiniMax corporate logo — a short "mini" peak beside a
 * tall "max" one, drawn on the same 24-unit grid and ink colour as the other
 * vector marks so it carries their weight in the rail.
 */
export function MiniMaxMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d="M3.6 19.2 7.8 12 12 19.2 16.2 4.8 20.4 19.2"
        fill="none"
        stroke="var(--color-ink)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Official pi (pi.dev) mark — geometric "Pi" wordmark from pi.dev/logo.svg. */
export function PiMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 800 800" className={cn("fill-[var(--color-ink)]", className)} aria-hidden>
      {/* P shape: outer boundary clockwise, inner hole counter-clockwise */}
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      {/* i dot */}
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

export function ProviderMark({ driverKind, size, className }: IconProps & { driverKind: string }) {
  switch (driverKind) {
    case "grok":
    case "grokAgent":
      return <GrokMark size={size} className={className} />;
    case "deepseek":
    case "deepseekAgent":
    case "dsh":
    case "dshAgent":
      return <DeepSeekMark size={size} className={className} />;
    case "claude":
    case "claudeAgent":
      return <ClaudeMark size={size} className={className} />;
    case "codex":
      return <CodexMark size={size} className={className} />;
    case "kimi":
    case "kimiAgent":
      return <KimiMark size={size} className={className} />;
    case "droid":
    case "droidAgent":
      return <DroidMark size={size} className={className} />;
    case "cursor":
    case "cursorAgent":
      return <CursorMark size={size} className={className} />;
    case "gemini":
    case "geminiAgent":
    case "antigravity":
    case "antigravityAgent":
      return <AntigravityMark size={size} className={className} />;
    case "opencodeGo":
      return <OpenCodeMark size={size} className={className} />;
    case "qwenAgent":
      return <QwenMark size={size} className={className} />;
    case "hermesAgent":
      return <HermesMark size={size} className={className} />;
    case "boxAgent":
      return <ComputerMark size={size} className={className} />;
    case "piAgent":
      return <PiMark size={size} className={className} />;
    case "minimax":
      return <MiniMaxMark size={size} className={className} />;
    default:
      return (
        <span className="flex size-full items-center justify-center text-[10px] font-semibold tracking-tight text-ink-secondary">
          {(driverKind.replace(/Agent$/i, "").slice(0, 1) || "?").toUpperCase()}
        </span>
      );
  }
}
