// Test harness for tests/e2e/tv-face-avatar.visual.spec.ts.
//
// Renders one board with four TVFaceAvatar instances so the visual spec can
// pin the first paint of each one, watch the timed enter→hold transition on
// the thinking avatar, and remount a keyed hold avatar on demand.
//
// Every cell mounts on the multi-GIF tree: blue thinking-class states stay
// off the one-file packs (they have no dedicated thinking pack), and
// transitionSpeed 2 keeps a non-thinking state there too, since the one-file
// player has no speed control. The one-file pack path itself is covered by
// the packs unit tests and the board snapshot.
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
        <span>Still tools</span>
        <div data-testid="still-happy">
          <TVFaceAvatar color="blue" state="tools" animated={false} transitionSpeed={2} size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Animated resting</span>
        <div data-testid="animated-resting">
          <TVFaceAvatar color="blue" transitionSpeed={2} state="idle" animated size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Animated thinking</span>
        <div data-testid="animated-hold">
          <TVFaceAvatar color="blue" state="thinking" animated size={96} />
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span>Remount slot</span>
        <div data-testid="remount-slot">
          <TVFaceAvatar
            color="blue"
            transitionSpeed={2}
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
