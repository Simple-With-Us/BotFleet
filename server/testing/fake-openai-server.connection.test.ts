// The fake OpenAI server ends the connection of every request it answers.
// In its own file, and sending no credential: the fixture's smoke test for
// header redaction needs a long `Authorization` value, and this one needs to
// prove something about the socket alone.
import { afterEach, describe, expect, it } from "vitest";

import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fake-openai-server.ts";

describe("fake-openai-server connection", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("ends the connection of each answer, so no socket outlives the fake that opened it", async () => {
    // The next fake a file starts takes the same port. A socket kept alive
    // for the fake that is gone is still in the caller's pool by then, and
    // the request that reuses it fails at random: the fixture's own smoke
    // test failed 6 times in 40 runs before the fixture did this.
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "json", body: { choices: [] } });
    server.queueCompletion({ kind: "sse", frames: ["[DONE]"] });
    const headers = { "content-type": "application/json" };
    const completion = await fetch(`${server.url}/chat/completions`, { method: "POST", headers, body: "{}" });
    const stream = await fetch(`${server.url}/chat/completions`, { method: "POST", headers, body: "{}" });
    const models = await fetch(`${server.url}/models`);
    for (const answer of [completion, stream, models]) {
      expect(answer.status).toBe(200);
      expect(answer.headers.get("connection")).toBe("close");
      await answer.text();
    }
  });

  it("still cuts its own body off when a script says to, which reads as a premature close", async () => {
    // The one answer that must not say `connection: close`: said to close,
    // a body that stops early reads as a finished empty stream instead, and
    // the driver retry it exists to provoke never happens.
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "close" });
    const answer = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("connection")).not.toBe("close");
    await expect(answer.text()).rejects.toThrow();
  });
});
