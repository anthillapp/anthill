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
 * the `Sec-WebSocket-Accept` header the server answers with.
 */
function handshakeAccept(port: number, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        "GET /api HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
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
    expect(await handshakeAccept(server.port, RFC_KEY)).toBe(RFC_ACCEPT);
  });

  it("round-trips a message over the WebSocket", async () => {
    // Echo whatever arrives back over the broadcast, so the test is
    // self-contained (no bridge attached).
    server.onMessage((message) => {
      server.broadcast({ echo: message });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api`);
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
