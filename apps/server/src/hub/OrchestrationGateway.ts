// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The private loopback gateway owns raw HTTP channels.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type WebSocket from "ws";
import { MAX_TUNNEL_BUFFER, forwardHeaders, sendFrame, type TunnelFrame } from "./protocol.ts";
import { orchestrationPath } from "./OrchestrationRouter.ts";

/** An authenticated loopback entry point for the local MCP forwarding service. */
export function createOrchestrationGateway(options: {
  readonly tunnel: WebSocket;
  readonly secret: string;
  readonly ready: () => boolean;
}) {
  const pending = new Map<string, NodeHttp.ServerResponse>();
  const server = NodeHttp.createServer((request, response) => {
    const actual = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.secret}`);
    if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected)) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (!options.ready() || pending.size >= 128) {
      response.writeHead(503);
      response.end();
      return;
    }
    const raw = request.url ?? "/";
    const catalog = raw === "/hub/environments" && request.method === "GET";
    const match = /^\/hub\/environments\/([^/]+)(\/.*)$/.exec(raw);
    let destination: string | undefined;
    try {
      destination = match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
    } catch {
      /* Invalid route below. */
    }
    const path = match?.[2];
    if (
      !catalog &&
      (destination === undefined ||
        path === undefined ||
        !orchestrationPath(request.method ?? "GET", path))
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    const id = NodeCrypto.randomUUID();
    pending.set(id, response);
    const deadline = setTimeout(() => {
      response.destroy();
    }, 65_000);
    response.once("close", () => {
      clearTimeout(deadline);
      pending.delete(id);
      sendFrame(options.tunnel, { type: "peer-cancel", id });
    });
    if (catalog) {
      sendFrame(options.tunnel, { type: "peer-catalog", id });
      return;
    }
    // The route has been validated above; these checks keep the typed boundary explicit.
    if (destination === undefined || path === undefined) {
      response.destroy();
      return;
    }
    sendFrame(options.tunnel, {
      type: "peer-http-open",
      id,
      environmentId: destination,
      method: request.method ?? "POST",
      path,
      headers: forwardHeaders(request.headers),
    });
    request.on("data", (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length; offset += 48 * 1024)
        sendFrame(options.tunnel, {
          type: "peer-http-data",
          id,
          data: chunk.subarray(offset, offset + 48 * 1024).toString("base64"),
        });
    });
    request.on("end", () => sendFrame(options.tunnel, { type: "peer-http-end", id }));
    request.on("error", () => response.destroy());
  });
  const handle = (frame: TunnelFrame) => {
    if (!("id" in frame)) return false;
    const response = pending.get(frame.id);
    if (!response) return false;
    if (frame.type === "peer-catalog-result") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(frame.catalog));
    } else if (frame.type === "peer-http-head")
      response.writeHead(frame.status, forwardHeaders(frame.headers));
    else if (frame.type === "peer-http-data") {
      response.write(Buffer.from(frame.data, "base64"));
      if (response.writableLength > MAX_TUNNEL_BUFFER) response.destroy();
    } else if (frame.type === "peer-http-end") response.end();
    else return false;
    return true;
  };
  const close = () => {
    for (const response of pending.values()) response.destroy();
    server.closeAllConnections();
    server.close();
  };
  return { server, handle, close };
}
