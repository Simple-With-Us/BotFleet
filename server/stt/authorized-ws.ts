// A minimal WebSocket client that can send an Authorization header.
// The browser/Node global WebSocket API cannot, and xAI STT requires a
// Bearer header rather than a query token.
import { Buffer } from "node:buffer";
import { randomBytes, createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";

export interface AuthorizedWs {
  sendText(text: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number): void;
  readonly readyState: number;
}

export interface AuthorizedWsHandlers {
  onOpen?: () => void;
  onMessage?: (data: string) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function acceptKey(secKey: string): string {
  return createHash("sha1").update(`${secKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  const header = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const out = Buffer.alloc(header + 4 + length);
  out[0] = 0x80 | opcode;
  const mask = randomBytes(4);
  if (length < 126) {
    out[1] = 0x80 | length;
  } else if (length < 65_536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeUInt32BE(0, 2);
    out.writeUInt32BE(length, 6);
  }
  mask.copy(out, header);
  for (let i = 0; i < length; i += 1) out[header + 4 + i] = payload[i]! ^ mask[i % 4]!;
  return out;
}

function decodeFrames(buffer: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const high = buffer.readUInt32BE(cursor);
      const low = buffer.readUInt32BE(cursor + 4);
      cursor += 8;
      if (high !== 0 || low > 0x7fffffff) throw new Error("WebSocket frame is too large.");
      length = low;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) break;
    let payload: Buffer = Buffer.alloc(length);
    buffer.copy(payload, 0, cursor + maskLength, cursor + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      const copy = Buffer.from(payload);
      for (let i = 0; i < copy.length; i += 1) copy[i] = copy[i]! ^ mask[i % 4]!;
      payload = copy;
    }
    onFrame(opcode, payload);
    offset = cursor + maskLength + length;
  }
  const leftover = Buffer.alloc(buffer.length - offset);
  buffer.copy(leftover, 0, offset);
  return leftover;
}

export type AuthorizedWsOpener = (url: string, headers: Record<string, string>, handlers: AuthorizedWsHandlers) => Promise<AuthorizedWs>;

/** Open a WebSocket and attach the given request headers (Authorization). */
export const openAuthorizedWebSocket: AuthorizedWsOpener = (url, headers, handlers) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const target = new URL(url);
    const isSecure = target.protocol === "wss:" || target.protocol === "https:";
    const secKey = randomBytes(16).toString("base64");
    const request = (isSecure ? httpsRequest : httpRequest)({
      protocol: isSecure ? "https:" : "http:",
      hostname: target.hostname,
      port: target.port || (isSecure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        ...headers,
        Host: target.host,
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": secKey,
      },
    });
    const fail = (error: Error) => {
      if (settled) {
        handlers.onError?.(error);
        return;
      }
      settled = true;
      reject(error);
    };
    request.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    request.on("upgrade", (response: IncomingMessage, socket) => {
      if (response.statusCode !== 101) {
        socket.destroy();
        fail(new Error(`WebSocket upgrade failed (HTTP ${response.statusCode ?? "unknown"}).`));
        return;
      }
      const expected = acceptKey(secKey);
      const actual = String(response.headers["sec-websocket-accept"] ?? "");
      if (actual !== expected) {
        socket.destroy();
        fail(new Error("WebSocket accept header did not match."));
        return;
      }
      let readyState = OPEN;
      let remainder: Buffer = Buffer.alloc(0);
      const sendFrame = (opcode: number, payload: Uint8Array) => {
        if (readyState !== OPEN) return;
        socket.write(frame(opcode, payload));
      };
      const sendText = (text: string) => {
        sendFrame(0x1, Buffer.from(text, "utf8"));
      };
      const sendBinary = (data: Uint8Array) => {
        sendFrame(0x2, data);
      };
      const close = (code = 1000) => {
        if (readyState !== OPEN) return;
        readyState = CLOSING;
        const reason = Buffer.alloc(2);
        reason.writeUInt16BE(code, 0);
        try { socket.write(frame(0x8, reason)); } catch { /* already gone */ }
        socket.end();
      };
      socket.on("data", (chunk: Buffer) => {
        try {
          remainder = decodeFrames(Buffer.concat([remainder, chunk]), (opcode, payload) => {
            if (opcode === 0x1) handlers.onMessage?.(payload.toString("utf8"));
            else if (opcode === 0x8) close();
            else if (opcode === 0x9) socket.write(frame(0xa, payload));
          });
        } catch (error) {
          handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
          socket.destroy();
        }
      });
      socket.on("error", (error) => handlers.onError?.(error instanceof Error ? error : new Error(String(error))));
      socket.on("close", () => {
        readyState = CLOSED;
        handlers.onClose?.();
      });
      const client: AuthorizedWs = {
        sendText,
        sendBinary,
        close,
        get readyState() { return readyState; },
      };
      settled = true;
      resolve(client);
      handlers.onOpen?.();
    });
    request.on("response", (response) => {
      fail(new Error(`WebSocket upgrade failed (HTTP ${response.statusCode ?? "unknown"}).`));
      response.resume();
    });
    request.end();
  });
};
