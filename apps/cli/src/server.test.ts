/**
 * The CLI's web server: the `/health` endpoint, static file serving, and the
 * hand-rolled RFC6455 WebSocket at `/api`.
 *
 * The WebSocket test uses the canonical RFC 6455 §1.3 handshake vector
 * (key `dGhlIHNhbXBsZSBub25jZQ==` -> accept `s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`)
 * to catch a wrong magic value. The constant was once transcribed with a
 * corrupted tail, which made every real client (browsers, `ws`, undici)
 * reject the handshake while a raw client that reused the same wrong
 * constant appeared to work — so the test asserts the accept against the
 * published vector, not against a value the server itself computes.
 */

import { connect } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type CliServer } from "./server.js";

/** The canonical RFC 6455 §1.3 handshake vector. */
const RFC_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const RFC_ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

/**
 * Open a raw TCP connection, send a handshake with the given key, and return
 * the `Sec-WebSocket-Accept` header the server answers with. `token` is the
 * per-process token the server requires; omit it to test the rejection.
 */
function handshakeAccept(
  port: number,
  key: string,
  token?: string,
  origin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      let request =
        `GET /api${token ? `?token=${token}` : ""} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n";
      if (origin) request += `Origin: ${origin}\r\n`;
      request += "\r\n";
      socket.write(request);
    });
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("handshake timeout"));
    }, 5000);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/Sec-WebSocket-Accept: (.+)/i);
      if (match) {
        clearTimeout(timer);
        socket.destroy();
        resolve(match[1]!.trim());
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Open a raw TCP connection, do the handshake (with an optional token and
 * Origin), then send one raw frame and read the server's answer. A non-101
 * handshake status is returned as-is; a 101 followed by a close frame returns
 * the close code. Used to test the frame-level rejections, which the
 * `WebSocket` API cannot express (it masks every frame for us).
 */
function rawWebSocketExchange(
  port: number,
  token: string | undefined,
  origin: string | undefined,
  frame: Buffer,
): Promise<{ status: number; closeCode: number | null }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      let request =
        `GET /api${token ? `?token=${token}` : ""} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${RFC_KEY}\r\n` +
        "Sec-WebSocket-Version: 13\r\n";
      if (origin) request += `Origin: ${origin}\r\n`;
      request += "\r\n";
      socket.write(request);
    });
    let headerBuf = "";
    let sentFrame = false;
    let responseBuf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw ws timeout"));
    }, 5000);
    socket.on("data", (chunk: Buffer) => {
      if (!sentFrame) {
        headerBuf += chunk.toString("latin1");
        const statusMatch = headerBuf.match(/^HTTP\/1.1 (\d+)/);
        if (!statusMatch) return;
        const status = Number(statusMatch[1]);
        if (status !== 101) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ status, closeCode: null });
          return;
        }
        if (!headerBuf.includes("\r\n\r\n")) return; // wait for the full headers
        sentFrame = true;
        socket.write(frame);
      } else {
        responseBuf = Buffer.concat([responseBuf, chunk]);
        if (responseBuf.length >= 4 && (responseBuf[0]! & 0x0f) === 0x8) {
          const closeCode = responseBuf.readUInt16BE(2);
          clearTimeout(timer);
          socket.destroy();
          resolve({ status: 101, closeCode });
        }
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("the CLI web server", () => {
  let server: CliServer;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "anthill-cli-"));
    await writeFile(join(dir, "index.html"), "<html>hello</html>");
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      paths: { userData: dir, home: dir },
      rendererDir: dir,
    });
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("answers /health", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it("serves the app shell at /", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello");
  });

  it("refuses a path that escapes the renderer root", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/..%2fsecret`);
    expect(res.status).toBe(404);
  });

  it("produces the RFC 6455 accept for the canonical handshake key", async () => {
    expect(await handshakeAccept(server.port, RFC_KEY, server.token)).toBe(RFC_ACCEPT);
  });

  it("rejects a WebSocket upgrade without the token", async () => {
    const { status } = await rawWebSocketExchange(server.port, undefined, undefined, Buffer.alloc(0));
    expect(status).toBe(401);
  });

  it("rejects a WebSocket upgrade with a wrong token", async () => {
    const { status } = await rawWebSocketExchange(server.port, "not-the-token", undefined, Buffer.alloc(0));
    expect(status).toBe(401);
  });

  it("rejects a WebSocket upgrade from a foreign origin", async () => {
    const { status } = await rawWebSocketExchange(server.port, server.token, "http://evil.example:4173", Buffer.alloc(0));
    expect(status).toBe(403);
  });

  it("accepts a WebSocket upgrade from the loopback origin", async () => {
    // A 101 (the accept header is present) means the origin was accepted.
    await expect(
      handshakeAccept(server.port, RFC_KEY, server.token, `http://127.0.0.1:${server.port}`),
    ).resolves.toBe(RFC_ACCEPT);
  });

  it("rejects an unmasked client frame (RFC 6455 §5.1)", async () => {
    // FIN + text, length 5, MASK bit 0, then "hello" — a frame a client must
    // never send. The old code read it raw (the mask check was dead);
    // now the server fails the connection with 1002.
    const unmaskedText = Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const { closeCode } = await rawWebSocketExchange(server.port, server.token, undefined, unmaskedText);
    expect(closeCode).toBe(1002);
  });

  it("rejects a frame that claims more than the message limit", async () => {
    // A 64-bit length header claiming 17 MiB, with no payload sent: the
    // server must refuse it at the header, before waiting for 17 MiB that
    // will never arrive.
    const frame = Buffer.alloc(10);
    frame[0] = 0x81; // FIN + text
    frame[1] = 0x7f; // 64-bit length follows
    frame.writeBigUInt64BE(BigInt(17 * 1024 * 1024), 2);
    const { closeCode } = await rawWebSocketExchange(server.port, server.token, undefined, frame);
    expect(closeCode).toBe(1009);
  });

  it("round-trips a message over the WebSocket", async () => {
    // Echo whatever arrives back over the broadcast, so the test is
    // self-contained (no bridge attached).
    server.onMessage((message) => {
      server.broadcast({ echo: message });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api?token=${server.token}`);
    const response = await new Promise<{ echo: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("round-trip timeout")), 5000);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, channel: "test", args: [] }));
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(event.data)) as { echo: unknown });
      };
      ws.onerror = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
    expect(response.echo).toEqual({ id: 1, channel: "test", args: [] });
    ws.close();
  });
});
