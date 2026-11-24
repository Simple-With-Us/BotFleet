// The controller half's link to the worker, as three pieces that can be
// proved on their own (BF-2559 T6b).
//
// The controller child is an entry script:  importing it runs the whole
// fixture.  These three pieces live here instead, where an offline test can
// hold each of them to what it promises:  a body that arrives whole is read
// and parsed, a body that is interrupted or oversized is refused instead of
// waited on, a socket that cannot be bound settles instead of waiting, and a
// server with a connection still open still closes.
import type { IncomingMessage, Server } from "node:http";

import { z } from "zod";

/** The largest worker body the controller will read. */
export const MAX_WORKER_BODY_BYTES = 1_048_576;

/**
 * The body of one worker request, read as JSON.
 *
 * The worker boundary parses this JSON against the worker's own schema
 * before any field of it is read, and it is the boundary's own contract
 * that a body arrives unparsed.
 *
 * A body that is interrupted is refused rather than waited on, because a
 * promise that never settles leaves the worker boundary without an answer for
 * the whole run, and a body past the cap is refused rather than buffered,
 * because a body of any size would be read into this process's memory.
 */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- HTTP boundary: the worker boundary parses this JSON against the worker's own schema before any field of it is read
export function readWorkerBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let received = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (part: Buffer) => {
      if (settled) return;
      received += part.length;
      if (received > MAX_WORKER_BODY_BYTES) {
        fail(new Error("the worker body is too large"));
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on("error", (error: Error) => fail(error));
    req.on("close", () => fail(new Error("the worker body was interrupted")));
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("the worker body is not JSON"));
      }
    });
  });
}

/**
 * Listen on the loopback interface and resolve with the port that was taken.
 *
 * A bind failure settles the promise:  a listen that never settles would
 * leave the caller waiting out its whole deadline with no port to publish.
 */
export function listenOnLoopback(server: Server, port = 0): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      try {
        resolve(z.object({ port: z.number() }).parse(server.address()).port);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("the server did not report the port it took"));
      }
    });
  });
}

/**
 * Close the controller's server and wait for it.
 *
 * The worker's link is a keep-alive connection, so the sockets are dropped
 * before the server is closed:  a close that waits for them would never
 * resolve, and whatever the server holds would never be released.
 */
export function closeWorkerServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    }),
  );
}
