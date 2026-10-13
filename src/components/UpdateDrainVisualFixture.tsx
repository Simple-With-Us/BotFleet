// Test harness for tests/e2e/update-drain.visual.spec.ts.
//
// Mounts the real, connected <UpdateDrainNotice /> — the line a chat or a room
// shows above its composer while an update holds new work.  Nothing here is
// mocked in the browser: the notice reads the hold the way it does in the app,
// from `GET /api/update/status`, and the spec answers that one route with a
// hold whose times are fixed against the page clock.  StoreProvider is not
// used (it would hydrate from the bot server), and none of the notice needs it.
//
// The frame stands in for the composer column: the notice carries the
// composer's own side padding, so it has to be seen at the width it lives at.
import { UpdateDrainNotice } from "./UpdateDrainNotice";

export default function UpdateDrainVisualFixture() {
  return (
    <main className="min-h-screen bg-app p-6 text-ink">
      <div
        data-testid="update-drain-frame"
        className="mx-auto w-full max-w-[720px] rounded-xl border border-hairline/40 bg-app pb-3 pt-6"
      >
        <UpdateDrainNotice />
      </div>
    </main>
  );
}
