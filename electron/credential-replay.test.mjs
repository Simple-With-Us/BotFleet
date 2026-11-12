import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// main.mjs imports the "electron" module and runs Electron-runtime side
// effects at load time, so it cannot be imported directly under vitest —
// same constraint electron/credential-patch.node-test.mjs documents for
// CREDENTIAL_PATCH. This checks the SOURCE SHAPE of the two call sites a
// custom engine's encrypted key must be replayed from instead: a spawned
// child (inside startServerOn) and an already-running harness this launch
// only attaches to (inside startServerPackaged). Missing either one leaves
// that boot path's custom engines keyless with no error — exactly the kind
// of silent regression a source-shape check catches that manual testing
// easily misses (the attach path only fires when a harness already happens
// to be running).
const MAIN_SOURCE = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

describe("custom-engine credential replay on boot", () => {
  it("prepares durable markers before the update receipt and requires them before normal server startup", () => {
    const preparation = MAIN_SOURCE.indexOf("const markers = secureCredentialMarkers({ strict: true });");
    const receipt = MAIN_SOURCE.indexOf("createUpdateCredentialReceipt(build, markers.markerNames)");
    const migration = MAIN_SOURCE.indexOf("if (!secureCredentialMarkers().ok) {");
    const startup = MAIN_SOURCE.indexOf("serverReady = await startServerPackaged()");
    expect(preparation).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(preparation);
    expect(migration).toBeGreaterThan(-1);
    expect(startup).toBeGreaterThan(migration);
    expect(MAIN_SOURCE.slice(migration, startup)).toMatch(/app\.quit\(\);\s+return;/);
  });

  it("replays stored instance credentials on the SPAWN path (startServerOn's ready branch)", () => {
    const match = MAIN_SOURCE.match(
      /if \(identity\.outcome === "ready"\) \{([\s\S]*?)\n {4}\}/,
    );
    expect(match, "startServerOn's ready branch not found").not.toBeNull();
    expect(match[1]).toMatch(/await replayAttachedWorkspaceCredentials\(port,/);
  });

  it("also replays stored instance credentials on the ATTACH path (startServerPackaged's attached branch)", () => {
    // The regression this closes: a harness this launch only ATTACHES to
    // (already running from an earlier launch, or another window) never
    // goes through startServerOn at all, so its own replay call is the
    // ready-branch's alone — an attached harness that has since been
    // restarted by something outside this code path had no memory of any
    // instanceKeyOverrides a prior launch's replay put into it, and every
    // custom engine with an encrypted key silently went keyless.
    const startIdx = MAIN_SOURCE.indexOf('if (result.mode === "attached") {');
    expect(startIdx, 'startServerPackaged\'s attached branch not found').toBeGreaterThan(-1);
    const attachedBranchSource = MAIN_SOURCE.slice(startIdx, startIdx + 800);
    expect(attachedBranchSource).toMatch(/await replayAttachedWorkspaceCredentials\(SERVER_PORT, expectedBuild\);/);
  });

  it("declares credential:set-instance as a sibling of credential:set, not folded into its fixed CREDENTIAL_PATCH union", () => {
    expect(MAIN_SOURCE).toContain('ipcMain.handle("credential:set-instance"');
    // A custom engine's instance id is operator-chosen at creation, so it is
    // validated defensively here too (the server's own route already
    // enforces the [\w.-]+ shape) rather than trusted as an arbitrary
    // renderer-supplied string reaching a filesystem/network call.
    expect(MAIN_SOURCE).toMatch(/credential:set-instance[\s\S]{0,400}\/\^\[\\w\.-\]\+\$\//);
  });

  it("sends newly-set instance keys with external secret storage", () => {
    const startIdx = MAIN_SOURCE.indexOf('ipcMain.handle("credential:set-instance"');
    expect(startIdx).toBeGreaterThan(-1);
    const handlerSource = MAIN_SOURCE.slice(startIdx, startIdx + 2000);
    expect(handlerSource).toMatch(/secretStorage=external/);

    // Restore transport, owner proof, and disk non-persistence are exercised
    // behaviorally in credential-restore.test.mjs and the harness API tests.
  });

  it("declares credential:clear-instance as a delete-time-only encrypted-store purge, with no live fetch/PATCH of its own", () => {
    // The bug a fresh review caught: deleteCustomEngine used to purge via
    // credential:set-instance(id, ""), which PATCHes the live harness and
    // reloads that provider — settling any busy bot on it as no-longer-busy
    // and silently defeating DELETE /api/instances/:id's own busy-bot guard
    // when called BEFORE the delete. credential:clear-instance exists so the
    // renderer can purge AFTER deleting without ever touching the live
    // harness at all — this handler's own body must contain no fetch/PATCH.
    const startIdx = MAIN_SOURCE.indexOf('ipcMain.handle("credential:clear-instance"');
    expect(startIdx, "credential:clear-instance handler not found").toBeGreaterThan(-1);
    const endIdx = MAIN_SOURCE.indexOf("\n});", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const handlerSource = MAIN_SOURCE.slice(startIdx, endIdx);
    expect(handlerSource).not.toMatch(/fetch\(/);
    expect(handlerSource).toMatch(/updateSecureCredentialDocument/);
    expect(handlerSource).toMatch(/\/\^\[\\w\.-\]\+\$\//);
  });

  it("self-heals a stale encrypted instance key when its replay 404s (crash-interrupted delete)", () => {
    // Residual gap even with delete-then-purge ordering: if the app is
    // killed between DELETE succeeding and credential:clear-instance's own
    // purge completing, credentials.bin can still hold a key for an
    // instance id that no longer exists. The next boot's replay PATCH for
    // that id 404s (nothing to apply it to) — treat that as the signal to
    // drop the stale entry right then, before a differently-created engine
    // could ever reuse the same instance id and inherit it.
    const replayIdx = MAIN_SOURCE.indexOf("async function replayAttachedWorkspaceCredentials");
    expect(replayIdx).toBeGreaterThan(-1);
    const replaySource = MAIN_SOURCE.slice(replayIdx, MAIN_SOURCE.indexOf("async function startServerPackaged", replayIdx));
    expect(replaySource).toMatch(/restoreInstanceCredentials/);
    expect(replaySource).toMatch(/for \(const id of instances\.missing\) delete credentials\.instanceKeys\[id\]/);
    expect(replaySource).toMatch(/updateSecureCredentialDocument/);
  });
});
