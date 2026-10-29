import { offlineLocalVmAction, type OfflineVmAction } from "./local-vm-offline.ts";

const action = process.argv[2];
if (action !== "status" && action !== "create-stopped" && action !== "stop") {
  process.stdout.write(JSON.stringify({ ok: false, error: "Expected status, create-stopped, or stop" }) + "\n");
  process.exitCode = 2;
} else {
  offlineLocalVmAction(action satisfies OfflineVmAction).then(
    (result) => process.stdout.write(JSON.stringify(result) + "\n"),
    (error: Error) => {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message || "Local VM action failed" }) + "\n");
      process.exitCode = 1;
    },
  );
}
