import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { normalize, resolve, sep } from "node:path";
import type { Socket } from "node:net";
import type { Paths } from "./paths.js";

/**
 * The CLI's web interface: a `node:http` server bound to 127.0.0.1 that
 * serves the built renderer (`out/renderer`), a `/health` endpoint, and a
 * hand-rolled RFC6455 WebSocket at `/api` (no `ws` dependency; the
 * handshake and frame codec use `node:crypto`).
 *
 * Observation-only, like the desktop: the server makes no network calls of
 * its own — it only listens on the loopback interface and answers the
 * browser that opened it.
 *
 * The WebSocket is deliberately small: the handshake (Sec-WebSocket-Accept
 * per RFC6455 §4.1), text frames (including fragmentation), ping/pong,
 * close, and one broadcast method for the bridge. Client frames arrive
 * masked (RFC6455 §5.1); server frames are sent unmasked.
 */
export type ServerOptions = {
  host: string;
  port: number;
  paths: Paths;
  /** Where the built renderer lives on disk. */
  rendererDir: string;
};

export type CliServer = {
  server: Server;
  /** The port actually bound (the requested port, or the one chosen when 0). */
  port: number;
  /** Broadcast one JSON-serialisable message to every connected client. */
  broadcast(message: unknown): void;
  /**
   * Register the handler for messages arriving from a client. The value is
   * the parsed JSON when the frame is valid JSON, else the raw string.
   * The bridge registers its request handler here.
   */
  onMessage(handler: (message: unknown) => void): void;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const payload = Buffer.from(message, "utf8");
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": payload.length,
  });
  res.end(payload);
}

/**
 * Serve one file from the renderer root. `/` is the app shell; any path
 * that resolves outside the root (a `..` escape) is a 404.
 */
async function serveStatic(
  res: ServerResponse,
  root: string,
  pathname: string,
  headOnly: boolean,
): Promise<void> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(root, `.${rel}`);
  if (!file.startsWith(root + sep)) {
    sendError(res, 404, "not found");
    return;
  }
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    sendError(res, 404, "not found");
    return;
  }
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "content-length": data.length,
  });
  res.end(headOnly ? undefined : data);
}

// ---------------------------------------------------------------------------
// WebSocket (RFC6455)
// ---------------------------------------------------------------------------

/** The magic value from RFC6455 §4.1, mixed into the handshake hash. */
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-5AB5DC259C66";
/** Refuse payloads bigger than this (a page of JSON is kilobytes at most). */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

type WsClient = {
  socket: Socket;
  /** Bytes received but not yet a complete frame. */
  pending: Buffer;
  /** A fragmented message in progress, if any. */
  fragment: { opcode: number; data: Buffer } | null;
  /** A close frame has been sent (or received); do not echo it again. */
  closing: boolean;
  closed: boolean;
};

/**
 * Encode one server-to-client frame. Server frames are unmasked
 * (RFC6455 §5.1: a server MUST NOT mask).
 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** XOR a client frame's payload with its 4-byte masking key (RFC6455 §5.3). */
function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i]! ^ mask[i % 4]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

/**
 * Create and start the CLI server.
 *
 * Resolves once the socket is bound; `port` is the port actually bound
 * (so a `--port 0` run reports the one the kernel chose).
 */
export function startServer(options: ServerOptions): Promise<CliServer> {
  const { host, port } = options;
  const root = normalize(options.rendererDir);

  const clients = new Set<WsClient>();
  let messageHandler: ((message: unknown) => void) | null = null;
  let closePromise: Promise<void> | null = null;

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host || "localhost"}`);

    if (url.pathname === "/api") {
      const isUpgrade =
        (req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
        req.headers["sec-websocket-version"] === "13";
      if (isUpgrade) {
        const key = req.headers["sec-websocket-key"];
        if (typeof key !== "string" || key.length === 0) {
          sendError(res, 400, "bad WebSocket handshake: missing Sec-WebSocket-Key");
          return;
        }
        // RFC6455 §4.1: base64(sha1(key + magic)).
        const accept = createHash("sha1").update(key + WS_MAGIC).digest("base64");
        res.writeHead(101, {
          upgrade: "websocket",
          connection: "upgrade",
          "sec-websocket-accept": accept,
        });
        res.end();
        // The 101 detaches the socket from the http server; from here on
        // it is ours (RFC6455 §4.1, the "Switching Protocols" step).
        attachWebSocket(req.socket);
        return;
      }
      sendError(res, 400, "/api is a WebSocket endpoint (RFC 6455); use an upgrade request");
      return;
    }

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, name: "anthill-cli" });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "method not allowed");
      return;
    }
    await serveStatic(res, root, url.pathname, req.method === "HEAD");
  }

  function attachWebSocket(socket: Socket): void {
    const client: WsClient = {
      socket,
      pending: Buffer.alloc(0),
      fragment: null,
      closing: false,
      closed: false,
    };
    clients.add(client);
    // Small frames should not wait for Nagle to batch them.
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      client.pending = Buffer.concat([client.pending, chunk]);
      consumeFrames(client);
    });
    socket.on("close", () => detach(client));
    socket.on("error", () => detach(client));
  }

  function detach(client: WsClient): void {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
  }

  /** Fail the connection with a close frame (RFC6455 §7.4). */
  function failProtocol(client: WsClient, code: number): void {
    if (client.closing || client.closed) return;
    client.closing = true;
    try {
      client.socket.write(encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff])));
    } catch {
      // The socket is already gone; the close frame is moot.
    }
    client.socket.destroy();
  }

  function consumeFrames(client: WsClient): void {
    for (;;) {
      const buf = client.pending;
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0;
      const opcode = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let length = buf[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < offset + 2) return;
        length = buf.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          failProtocol(client, 1009);
          return;
        }
        length = Number(big);
        offset += 8;
      }
      if (masked) offset += 4;
      const total = offset + length;
      if (buf.length < total) return; // wait for the rest of the frame
      let payload = buf.subarray(offset, total);
      if (masked) {
        // RFC6455 §5.1: a server MUST fail the connection if MASK is 0.
        if (!masked) {
          failProtocol(client, 1002);
          return;
        }
        payload = unmask(payload, buf.subarray(offset - 4, offset));
      }
      client.pending = buf.subarray(total);
      dispatchFrame(client, fin, opcode, payload);
    }
  }

  function dispatchFrame(
    client: WsClient,
    fin: boolean,
    opcode: number,
    payload: Buffer,
  ): void {
    switch (opcode) {
      case 0x0: // continuation
        if (!client.fragment) {
          failProtocol(client, 1002);
          return;
        }
        client.fragment.data = Buffer.concat([client.fragment.data, payload]);
        if (fin) {
          const done = client.fragment;
          client.fragment = null;
          deliver(client, done.opcode, done.data);
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (client.fragment) {
          failProtocol(client, 1002);
          return;
        }
        if (fin) deliver(client, opcode, payload);
        else client.fragment = { opcode, data: payload };
        return;
      case 0x8: // close
        if (!client.closing) {
          client.closing = true;
          // Echo the client's close code (1000 when it sent none).
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          try {
            client.socket.write(
              encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff])),
            );
          } catch {
            // Socket already gone.
          }
          client.socket.destroy();
        }
        return;
      case 0x9: // ping: answer with a pong carrying the same payload.
        try {
          client.socket.write(encodeFrame(0xa, payload));
        } catch {
          // Socket already gone.
        }
        return;
      case 0xa: // pong: nothing to do.
        return;
      default:
        failProtocol(client, 1002);
    }
  }

  function deliver(client: WsClient, opcode: number, data: Buffer): void {
    if (!messageHandler) return;
    if (opcode === 0x1) {
      // The renderer speaks JSON; forward the parsed value, falling back to
      // the raw string when a frame is not JSON.
      const text = data.toString("utf8");
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        // Not JSON: the raw string is the message.
      }
      messageHandler(value);
    } else {
      // Binary frames are not part of the app's protocol, but forward them
      // rather than dropping them silently.
      messageHandler(data);
    }
  }

  function broadcast(message: unknown): void {
    let frame: Buffer;
    try {
      frame = encodeFrame(0x1, Buffer.from(JSON.stringify(message), "utf8"));
    } catch {
      // Not serialisable: nothing to send.
      return;
    }
    for (const client of clients) {
      if (client.closed) continue;
      try {
        client.socket.write(frame);
      } catch {
        detach(client);
      }
    }
  }

  function onMessage(handler: (message: unknown) => void): void {
    messageHandler = handler;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolveClose, rejectClose) => {
      // Close every WebSocket (the http server does not track upgraded
      // sockets, so this is on us), then stop accepting.
      for (const client of clients) {
        if (client.closed) continue;
        try {
          client.socket.write(
            encodeFrame(0x8, Buffer.from([0x03, 0xe8])), // 1000: normal
          );
          client.socket.end();
        } catch {
          client.socket.destroy();
        }
      }
      clients.clear();
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    return closePromise;
  }

  return new Promise<CliServer>((resolveStart, rejectStart) => {
    server.on("error", rejectStart);
    server.listen(port, host, () => {
      const address = server.address();
      const bound =
        address !== null && typeof address === "object" ? address.port : port;
      resolveStart({ server, port: bound, broadcast, onMessage, close });
    });
  });
}
