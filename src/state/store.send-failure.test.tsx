// A send the server refuses, or cannot be reached for, has to tell the
// composer: the composer clears the moment Enter is pressed, and only the
// store hears the POST fail.  The store runs inside a provider, so the test
// renders one on the server, keeps the dispatch it hands out, and calls it
// after the render (a server render ignores the state update, which is all
// this test needs: the POST itself is real code against a stubbed fetch).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Action } from "./store";

function dispatchFromProvider(): (action: Action) => void {
  const seen: Array<(action: Action) => void> = [];
  function Probe() {
    seen.push(useStore().dispatch);
    return null;
  }
  renderToStaticMarkup(createElement(StoreProvider, null, createElement(Probe)));
  return seen[0]!;
}

function stubFetch(reply: () => Promise<Response>) {
  const fetchMock = vi.fn((_url: string) => reply());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const refused = () =>
  Promise.resolve(new Response(JSON.stringify({ error: "text required" }), { status: 400, statusText: "Bad Request" }));

describe("a composer send reports its failure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tells a 1:1 send's caller when the server refuses it", async () => {
    const fetchMock = stubFetch(refused);
    const onError = vi.fn();
    dispatchFromProvider()({ type: "send", botId: "bot-1", text: "a long prompt", onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("text required");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/bots/bot-1/messages");
  });

  it("tells a room send's caller when the server cannot be reached", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const onError = vi.fn();
    dispatchFromProvider()({ type: "sendGroup", groupId: "room-1", text: "a long prompt", onError });

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("Failed to fetch");
  });

  it("stays quiet when the server accepts the send", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 202 })));
    const onError = vi.fn();
    dispatchFromProvider()({ type: "send", botId: "bot-1", text: "hello", onError });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).not.toHaveBeenCalled();
  });

  it("still works for callers with no failure handler, like the voice call", async () => {
    const fetchMock = stubFetch(refused);
    dispatchFromProvider()({ type: "send", botId: "bot-1", text: "said aloud" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("cancelQueued DELETE errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  function seedQueuedBot(dispatch: (action: Action) => void) {
    dispatch({
      type: "botPatched",
      bot: {
        id: "b1",
        threadId: "t1",
        name: "Ada",
        title: "",
        description: "",
        notifications: false,
        color: "green",
        unread: false,
        modelSelection: { instanceId: "acp", model: "fake" },
        messages: [],
      },
    });
    dispatch({
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-drop",
      text: "hold",
    });
  }

  it("keeps the chip and skips onSettled when the harness has no DELETE route", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "no route: DELETE /api/bots/b1/queue/q-drop" }), {
          status: 404,
          statusText: "Not Found",
        }),
      ),
    );
    const dispatch = dispatchFromProvider();
    seedQueuedBot(dispatch);
    const onSettled = vi.fn();
    dispatch({ type: "cancelQueued", botId: "b1", queueId: "q-drop", onSettled });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("drops the chip and runs onSettled when a 404 means the entry is already gone", async () => {
    stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "queue entry not found" }), { status: 404 })),
    );
    const dispatch = dispatchFromProvider();
    seedQueuedBot(dispatch);
    const onSettled = vi.fn();
    dispatch({ type: "cancelQueued", botId: "b1", queueId: "q-drop", onSettled });

    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });
});
