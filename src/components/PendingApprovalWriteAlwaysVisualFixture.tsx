// Test harness for tests/e2e/pending-approval-write-always.visual.spec.ts.
//
// Pins the write-shaped MCP always-allow confirmation (ConfirmDialog) and the
// composer approval strip.  variant=dialog opens the warning modal;
// variant=strip shows the action row with Always allow visible.
import { z } from "zod";
import { StoreContext, initialState } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { PendingApprovalActions, PendingApprovalPanel, type Pending } from "./PendingApproval";

const variantSchema = z.enum(["dialog", "strip"]).catch("dialog");

const ALLOW_KEY = "provider-tool:claude:linear:create_issue:abcd1234";

const pending: Pending = {
  message: {
    id: "approval-card",
    role: "bot",
    kind: "options",
    at: 1,
    card: {
      title: "Allow tool",
      subtitle: "create issue on team ENG",
      options: ["Allow", "Deny"],
      requestId: "req-visual",
      tool: "mcp__linear__create_issue",
      allowKey: ALLOW_KEY,
      allowKeyWarnWrite: true,
    },
  },
  requestId: "req-visual",
  tool: "mcp__linear__create_issue",
  allowKey: ALLOW_KEY,
  allowKeyWarnWrite: true,
  detail: "create issue on team ENG",
};

const bot = {
  id: "bot-visual",
  threadId: "thread-visual",
  name: "Atlas",
  title: "Planner",
  description: "",
  notifications: true,
  color: "green" as const,
  unread: false,
  modelSelection: { instanceId: "claude", model: "claude-sonnet-4.5" },
  messages: [],
};

const noop = () => {};

export default function PendingApprovalWriteAlwaysVisualFixture() {
  const variant = variantSchema.parse(new URLSearchParams(window.location.search).get("variant"));
  const storeValue = {
    state: initialState,
    dispatch: noop,
    flushBotPatches: async () => {},
    refreshInstances: async () => {},
  };

  return (
    <StoreContext.Provider value={storeValue}>
      <div
        data-testid="pending-approval-write-fixture"
        data-fixture-variant={variant}
        className="w-[640px] bg-app text-ink"
      >
        <PendingApprovalPanel pending={pending} count={1} index={0} />
        <div className="border-t border-hairline/40 bg-panel">
          {variant === "strip" && (
            <PendingApprovalActions pending={pending} threadId="thread-visual" bot={bot} onCancelTurn={noop} />
          )}
        </div>
        {variant === "dialog" && (
          <ConfirmDialog
            open
            title="Always allow this write tool?"
            body={
              <>
                This tool can change data outside a read-only lookup.&nbsp; BotFleet will stop asking{" "}
                <span className="font-mono text-[12px]">{ALLOW_KEY}</span> on every future turn until you revoke it in
                this bot&apos;s settings.
              </>
            }
            confirmLabel="Always allow"
            destructive
            onCancel={noop}
            onConfirm={noop}
          />
        )}
      </div>
    </StoreContext.Provider>
  );
}
