// Test harness for tests/e2e/engine-marks.visual.spec.ts.
//
// Mounts the engine rail exactly as the model picker builds it — the same
// `size-9` button, the same `size={18}` mark, the same group labels — because
// that rail is where the owner saw the defect: most platform logos painted in
// the theme accent colour (2026-10-10).
//
// The fixture takes two parameters so both halves of the fix are visible in one
// screenshot and both are assertable:
//
//   ?fixture=engine-marks                    the preset skin named by `skin`
//   ?fixture=engine-marks&palette=hostile    a Custom Palette whose main text is
//                                            its accent, which is what turned
//                                            the ink-inheriting marks into
//                                            accent chips
//
// `main.tsx` stamps the skin before the first paint, exactly as the app does,
// so a screenshot cannot catch a frame of the wrong palette.
import { applyCustomTheme, applySkin, type CustomThemeConfig, type SkinId } from "@/lib/skins";
import { LOCAL_MODELS_DRIVER_KIND } from "@/lib/local-models";
import { ProviderMark } from "./ProviderIcons";

/** The same rail order ModelPicker's `railEngines` produces for a full cloud
 *  account, so the screenshot is the shape the owner reported on. */
const RAIL: readonly { kind: string; label: string }[] = [
  { kind: "grok", label: "Grok" },
  { kind: "boxAgent", label: "ASCII.dev Box" },
  { kind: "claude", label: "Claude" },
  { kind: "openai", label: "OpenAI" },
  { kind: "geminiAgent", label: "Antigravity" },
  { kind: "opencodeGo", label: "OpenCode" },
  { kind: "dsh", label: "Clutch" },
  { kind: "minimax", label: "MiniMax" },
  { kind: "mcode", label: "MiniMax Code" },
  { kind: "museSparkAgent", label: "Muse Code" },
];

/** Main text painted in the accent:  the palette shape that leaked into the
 *  logos.  Amber accent, amber main text, near-black secondary text. */
const HOSTILE_PALETTE: CustomThemeConfig = {
  appBg: "#fbf8f2",
  panelBg: "#fbf8f2",
  cardBg: "#ffffff",
  inkColor: "#a05f25",
  inkSecondaryColor: "#111418",
  accentColor: "#a05f25",
  hairlineColor: "#e5e0d6",
};

function params(): URLSearchParams {
  return new URLSearchParams(globalThis.window ? window.location.search : "");
}

function applyRequestedSkin(): string {
  const query = params();
  if (query.get("palette") === "hostile") {
    applyCustomTheme(HOSTILE_PALETTE);
    return "custom";
  }
  const skin = (query.get("skin") ?? "atelier") as SkinId;
  applySkin(skin);
  return skin;
}

// Stamped once, at module scope, so the first paint is already correct — the
// same reason main.tsx calls applySkin(readSkin()) outside the render.
const skin = applyRequestedSkin();

export default function EngineMarksVisualFixture() {
  return (
    <div
      data-testid="engine-marks-board"
      data-skin={skin}
      className="flex gap-6 bg-app p-6"
    >
      <div className="flex flex-col items-center gap-4">
        <div
          data-testid="engine-marks-rail"
          className="flex w-14 shrink-0 flex-col gap-1 border-r border-hairline/40 bg-panel p-2"
        >
          <div className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">Cloud</div>
          {RAIL.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              aria-label={label}
              title={label}
              data-testid={`engine-mark-${kind}`}
              className="relative flex size-9 items-center justify-center rounded-lg hover:bg-control/60"
            >
              <ProviderMark driverKind={kind} size={18} />
            </button>
          ))}
          <div className="px-0 pb-0.5 pt-2 text-center text-[9px]">Local</div>
          <button
            type="button"
            aria-label="Local Models"
            data-testid={`engine-mark-${LOCAL_MODELS_DRIVER_KIND}`}
            className="relative flex size-9 items-center justify-center rounded-lg hover:bg-control/60"
          >
            <ProviderMark driverKind={LOCAL_MODELS_DRIVER_KIND} size={18} />
          </button>
        </div>
      </div>

      {/* The picker trigger's own mark, which is the same component at 14px,
          next to a model name:  the pair the owner was looking at. */}
      <div className="flex items-center gap-2 rounded-2xl border border-hairline/50 bg-card px-3 py-2">
        <span data-testid="engine-marks-trigger" className="flex items-center gap-1.5">
          <ProviderMark driverKind="minimax" size={14} />
          <span className="text-[12px]">MiniMax-M3.1-Flash-Preview</span>
        </span>
      </div>
    </div>
  );
}