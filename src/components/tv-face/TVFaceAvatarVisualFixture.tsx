// Test harness for tests/e2e/tv-face-avatar.visual.spec.ts.
//
// Renders one board with four TVFaceAvatar instances so the visual spec can
// pin the first paint of each one, watch the timed enter→hold transition on
// the thinking avatar, and remount a keyed hold avatar on demand.
//
// The avatar component itself is untouched; this file is a pure renderer.
import { useState } from "react";
import { TVFaceAvatar } from "./TVFaceAvatar";

export default function TVFaceAvatarVisualFixture() {
  // Changing `remountKey` flips the React `key` on the remount-slot avatar
  // below, forcing a full unmount + mount. The next mount re-runs the
  // component's own first-paint path, so the post-remount src is real and
  // not a stale hold frame from the previous instance.
  const [remountKey, setRemountKey] = useState(0);

  return (
    <div
      data-testid="tv-face-board"
      style={{
        background: "#f4f4f5",
        padding: 24,
        display: "grid",
        gridTemplateColumns: "repeat(2, max-content)",
        gap: 24,
        alignItems: "start",
        justifyContent: "start",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Still happy</span>
        <div data-testid="still-happy">
          <TVFaceAvatar state="happy" animated={false} size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Animated resting</span>
        <div data-testid="animated-resting">
          <TVFaceAvatar state="idle" animated size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Animated thinking</span>
        <div data-testid="animated-hold">
          <TVFaceAvatar state="thinking" animated size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Remount slot</span>
        <div data-testid="remount-slot">
          <TVFaceAvatar
            key={`remount-${remountKey}`}
            state="idle"
            animated
            size={96}
          />
        </div>
        <button
          type="button"
          onClick={() => setRemountKey((k) => k + 1)}
        >
          Remount hold avatar
        </button>
      </div>
    </div>
  );
}
