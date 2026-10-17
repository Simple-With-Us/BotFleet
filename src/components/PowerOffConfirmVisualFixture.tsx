// Test harness for tests/e2e/power-off-confirm.visual.spec.ts.
//
// Mounts the real ConfirmDialog with the exact copy shared/bot-power.ts ships
// for "a working bot was switched Off", so the geometry being measured is the
// geometry a person meets rather than a mock of it.  This is the only dialog
// in the app with THREE answers, and all three labels are long, so the button
// row has to wrap at the narrow end — which is the thing worth pinning.
//
// The bot name is deliberately long.  A person's own name goes in the title
// AND the body, so the worst case for wrapping is a long name, not "Scout".
import {
  BOT_OFF_AFTER_TURN,
  BOT_OFF_KEEP_ON,
  BOT_OFF_STOP_AND_POWER_OFF,
  botOffWhileRunningBody,
  botOffWhileRunningTitle,
} from "../../shared/bot-power";
import { ConfirmDialog } from "./ConfirmDialog";

const BOT_NAME = "Regional Fleet Compliance Reviewer";

export default function PowerOffConfirmVisualFixture() {
  return (
    <ConfirmDialog
      open
      title={botOffWhileRunningTitle(BOT_NAME)}
      body={botOffWhileRunningBody(BOT_NAME)}
      confirmLabel={BOT_OFF_STOP_AND_POWER_OFF}
      cancelLabel={BOT_OFF_KEEP_ON}
      altLabel={BOT_OFF_AFTER_TURN}
      onCancel={() => {}}
      onAlt={() => {}}
      onConfirm={() => {}}
    />
  );
}