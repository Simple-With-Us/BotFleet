import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createRequestLog } from "./request-log.ts";
import { reconcile } from "../scripts/github-request-log-reconcile.mjs";

it("retains non-reconcilable routine events while reconciliation performs network reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "request-log-network-"));
  try {
    const filePath = join(dir, "log.md");
    const log = createRequestLog({ filePath, spoolPath: join(dir, "spool"), cursorPath: join(dir, "cursor") });
    reconcile({ org: "Org", hook: "9", log: filePath, cursor: join(dir, "reconcile"), get: () => {
      log.routineSubscriber({ kind: "routine.run", run: { id: "network", botId: "b", status: "completed", createdAt: Date.now() } });
      return { data: [] };
    } });
    expect(readFileSync(filePath, "utf8")).toContain("botfleet_routine");
    log.replay(); expect(readFileSync(filePath, "utf8").trim().split("\n")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
