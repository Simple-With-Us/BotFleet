import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { openAuthorizedWebSocket } from "./authorized-ws.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(secKey: string): string {
  return createHash("sha1").update(`${secKey}${GUID}`).digest("base64");
}

function unmaskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = payload.length < 126 ? 2 : 4;
  const out = Buffer.alloc(header + payload.length);
  out[0] = 0x81;
  if (payload.length < 126) {
    out[1] = payload.length;
    payload.copy(out, 2);
  } else {
    out[1] = 126;
    out.writeUInt16BE(payload.length, 2);
    payload.copy(out, 4);
  }
  return out;
}

describe("openAuthorizedWebSocket", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    for (const server of servers) server.close();
    servers.length = 0;
  });

  it("processes WebSocket frames that arrived with the upgrade response", async () => {
    const server = createServer();
    servers.push(server);
    server.on("upgrade", (request, socket) => {
      const secKey = String(request.headers["sec-websocket-key"] ?? "");
      const headers = Buffer.from(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${acceptKey(secKey)}\r\n`
        + "\r\n",
        "utf8",
      );
      socket.write(Buffer.concat([headers, unmaskedTextFrame('{"type":"transcript.created"}')]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const messages: string[] = [];
    const client = await openAuthorizedWebSocket(`ws://127.0.0.1:${port}/stt`, { Authorization: "Bearer test" }, {
      onMessage: (data) => messages.push(data),
    });
    await waitFor(() => messages.length > 0);
    expect(messages).toEqual(['{"type":"transcript.created"}']);
    client.close();
  });
});

function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("Timed out waiting for the upgrade head frame."));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}
