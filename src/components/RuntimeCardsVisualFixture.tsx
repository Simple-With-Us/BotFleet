// Test harness for tests/e2e/runtime-cards.visual.spec.ts.
//
// Renders the real LocalVmRuntimeCard and SharedVpsRuntimeCard under a
// StoreContext with a hand-built ConfigStatus so the spec can pin every
// user-visible state the cards can show (per-bot, replacement, normal,
// "Fetching VPS status…", the live per-bot caption, etc.) without booting
// the harness or `process.platform`.
//
// The fixture is mounted via /?fixture=runtime-cards (see src/main.tsx).
// URL params pick which state to render:
//
//   card  = local-vm | shared-vps | both
//   state = per-bot | shared | replacement | normal | loading | per-bot-caption
//
// The fixture fulfils /api/local-computer and /api/vps-computer via
// `page.route(...)` in the spec, so the card's own status poll gets a
// deterministic body for the chosen state.  `local-vm` states with no
// status override use the response the spec hands back; the fixture's
// ConfigStatus only drives the UI chrome (mode badge, toggles, headers).
import { useMemo, type Dispatch } from "react";
import { z } from "zod";
import { LocalVmRuntimeCard } from "./LocalVmRuntimeCard";
import { SharedVpsRuntimeCard } from "./SharedVpsRuntimeCard";
import { initialState, StoreContext, type Action, type ConfigStatus } from "@/state/store";

// The query string is browser-controlled, so `card` and `state` are parsed
// against the exact fixture vocabulary before they pick a state.  Unknown
// values fail loudly instead of silently rendering an unintended board.
const RuntimeCardsVisualFixtureParamsSchema = z
  .object({
    card: z.enum(["local-vm", "shared-vps", "both"]).default("both"),
    state: z
      .enum(["per-bot", "shared", "replacement", "normal", "loading", "per-bot-caption"])
      .default("normal"),
  })
  .strip();

type RuntimeCardsVisualFixtureParams = z.infer<typeof RuntimeCardsVisualFixtureParamsSchema>;

function buildConfig(
  state: RuntimeCardsVisualFixtureParams["state"],
  card: RuntimeCardsVisualFixtureParams["card"],
): ConfigStatus {
  const vpsConfigured = card === "shared-vps" || card === "both" || state === "loading";
  // Local-VM per-bot chrome only.  Replacement stays on the shared Local VM
  // face so Step 4 can render "Replace the Older or Unsafe VM".
  const localPerBot = state === "per-bot";
  const vpsPerBot = state === "per-bot-caption";
  return {
    host: { platform: "darwin" },
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: vpsConfigured, sshAlias: "vps" },
    rooms: { turnTimeoutMinutes: 60 },
    botDefaults: {
      computers: ["vm" as const],
      cloudBackend: "box",
      allowedComputers: ["vm" as const],
      computerProviders: {
        asciiBox: false,
        selfHostedVps: true,
        localVm: true,
        localMac: false,
      },
      vpsMode: vpsPerBot ? "per-bot" : "shared",
    },
    localVm: {
      mode: localPerBot ? "per-bot" : "shared",
      maxInstances: 1,
      shareCliCredentials: false,
      allowHostTerminal: false,
    },
  };
}

function boardParams(): RuntimeCardsVisualFixtureParams {
  const params = Object.fromEntries(new URLSearchParams(window.location.search));
  return RuntimeCardsVisualFixtureParamsSchema.parse(params);
}

export default function RuntimeCardsVisualFixture() {
  const { card, state } = useMemo(boardParams, []);
  const config = useMemo(() => buildConfig(state, card), [state, card]);

  const value = useMemo(
    () => ({
      state: {
        ...initialState,
        config,
      },
      dispatch: (() => {}) as Dispatch<Action>,
      flushBotPatches: async () => {},
      refreshInstances: async () => {},
    }),
    [config],
  );

  return (
    <StoreContext.Provider value={value}>
      <div
        data-testid="runtime-cards-board"
        style={{ background: "#f4f4f5", padding: 24, width: 720, display: "flex", flexDirection: "column", gap: 16 }}
      >
        {(card === "local-vm" || card === "both") && (
          <div data-testid="runtime-cards-local-vm">
            <LocalVmRuntimeCard />
          </div>
        )}
        {(card === "shared-vps" || card === "both") && (
          <div data-testid="runtime-cards-shared-vps">
            <SharedVpsRuntimeCard />
          </div>
        )}
      </div>
    </StoreContext.Provider>
  );
}
