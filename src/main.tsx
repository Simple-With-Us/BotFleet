import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applySkin, followsComputerLook, readSkin } from "./lib/skins";
import { initSentryFromRuntime } from "./lib/sentry";
import "./styles.css";

// Ask the harness for the live switch before starting even the packaged
// client.  A saved opt-out must win before tracing or replay can capture the
// first render; an unreachable harness leaves this window inert.
void initSentryFromRuntime();

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first.
applySkin(readSkin());

if (globalThis.window && window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const pref = readSkin();
    if (followsComputerLook(pref)) applySkin(pref);
  });
}

const rootElement = document.getElementById("root")!;
const fixtureParam =
  globalThis.window ? new URLSearchParams(window.location.search).get("fixture") : null;

if (fixtureParam === "tv-face") {
  // Visual-spec harness: dynamically import so the fixture chunk is not paid
  // for in the real app boot path. The App render below is unchanged for any
  // other URL.
  void import("./components/tv-face/TVFaceAvatarVisualFixture").then((mod) => {
    const Fixture = mod.default;
    createRoot(rootElement).render(
      <StrictMode>
        <Fixture />
      </StrictMode>,
    );
  });
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
