// Test harness for tests/e2e/sign-in-card.visual.spec.ts.
//
// Mounts the real Sign in needed card.  The state comes from
// /?fixture=sign-in-card&state=open|error|done.  There is no password
// field: the person signs in on the computer, and an error stays in the
// card until they hide it.
import type { SignInRequestCardData } from "../../shared/sign-in-request.ts";
import { SignInRequestCardView } from "./SignInRequestCard";

type CardState = "open" | "error" | "done";

function readState(): CardState {
  const raw = new URLSearchParams(window.location.search).get("state");
  if (raw === "error" || raw === "done") return raw;
  return "open";
}

const noop = () => {};

export default function SignInRequestCardVisualFixture() {
  const state = readState();
  const card: SignInRequestCardData = {
    site: "accounts.example.com",
    reason: "the inbox",
    status: state === "done" ? "done" : "open",
  };
  return (
    <div data-testid="sign-in-card-fixture" className="min-h-screen bg-app p-6 text-ink">
      <SignInRequestCardView
        card={card}
        busy={null}
        error={state === "error" ? "The computer could not be opened.\u00A0 Try again from the Computer panel." : null}
        onOpen={noop}
        onDone={noop}
        onCancel={noop}
        onDismissError={noop}
      />
    </div>
  );
}
