import assert from "node:assert/strict";
import test from "node:test";

import {
  assertTrustedSender,
  installTrustedIpcGuard,
  isTrustedRendererUrl,
} from "./renderer-trust.mjs";

const RENDERER_ORIGIN = "http://127.0.0.1:8799";

function senderFrame(url) {
  return { senderFrame: { url }, sender: { getURL: () => url } };
}

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, listener) => handlers.set(channel, listener),
    invoke: (channel, event, ...args) => {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler: ${channel}`);
      return listener(event, ...args);
    },
  };
}

test("the app's own renderer is the only trusted document", () => {
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:8799/", RENDERER_ORIGIN), true);
  // Every SPA route, query, and hash is the same page.
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:8799/rooms/abc?x=1#y", RENDERER_ORIGIN), true);
  // A late-bound origin (the port is not settled at startup) still resolves.
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:5199/", () => "http://127.0.0.1:5199"), true);

  assert.equal(isTrustedRendererUrl("https://botfleet.io/download", RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:9999/", RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl("http://evil.127.0.0.1.nip.io:8799/", RENDERER_ORIGIN), false);
  // The error page is preload-free and IPC-free, so it is not a sender.
  assert.equal(isTrustedRendererUrl("data:text/html,boom", RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl("file:///tmp/index.html", RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:8799.evil.example/", RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl(undefined, RENDERER_ORIGIN), false);
  assert.equal(isTrustedRendererUrl("http://127.0.0.1:8799/", ""), false);
});

test("a foreign sender is refused and the real one is accepted", () => {
  const foreign = { senderFrame: { url: "https://botfleet.io/download" } };
  const ours = senderFrame("http://127.0.0.1:8799/rooms/abc");
  assert.throws(
    () => assertTrustedSender(foreign, { origin: RENDERER_ORIGIN }),
    { message: "Only the BotFleet app window can do that" },
  );
  assert.equal(assertTrustedSender(ours, { origin: RENDERER_ORIGIN }), true);
  // An unknown sender is not a trusted one.
  assert.throws(() => assertTrustedSender({}, { origin: RENDERER_ORIGIN }), {
    message: "Only the BotFleet app window can do that",
  });
});

test("the ipcMain guard stops a foreign frame and leaves the real handler working", async () => {
  const ipcMain = installTrustedIpcGuard(fakeIpcMain(), { origin: () => RENDERER_ORIGIN });
  let ran = 0;
  ipcMain.handle("credential:set", async (_event, name) => {
    ran += 1;
    return `stored ${name}`;
  });
  // Electron turns a throw from a handle listener into a rejected invoke for
  // the renderer; the fake keeps the same shape so both paths are exercised.
  const call = (channel, event, ...args) => Promise.resolve().then(() => ipcMain.invoke(channel, event, ...args));

  await assert.rejects(call("credential:set", senderFrame("https://botfleet.io/download"), "ttsKey"), {
    message: "Only the BotFleet app window can do that",
  });
  assert.equal(ran, 0, "a foreign sender must not reach the handler body");

  // Same-origin path change is the same page: still ours.
  assert.equal(
    await call("credential:set", senderFrame("http://127.0.0.1:8799/threads/7"), "ttsKey"),
    "stored ttsKey",
  );
  assert.equal(ran, 1);
});

test("a handler that returns nothing still rejects a foreign sender", () => {
  const ipcMain = installTrustedIpcGuard(fakeIpcMain(), { origin: RENDERER_ORIGIN });
  ipcMain.handle("desktop:skin", () => undefined);
  assert.throws(() => ipcMain.invoke("desktop:skin", senderFrame("http://127.0.0.1:8800/")), {
    message: "Only the BotFleet app window can do that",
  });
  assert.doesNotThrow(() => ipcMain.invoke("desktop:skin", senderFrame("http://127.0.0.1:8799/")));
});
