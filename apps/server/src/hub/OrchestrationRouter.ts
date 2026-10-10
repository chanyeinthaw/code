// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Raw tunnel callbacks own request channels and deadlines.
import * as NodeCrypto from "node:crypto";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  type HubEnvironmentCatalog,
} from "@t3tools/contracts";
import type WebSocket from "ws";
import { sendFrame, type TunnelFrame } from "./protocol.ts";

/** Restrict environment-originated traffic to MCP and signed attachment uploads. */
export function orchestrationPath(method: string, path: string): boolean {
  if (path.includes("\\") || !path.startsWith("/") || path.startsWith("//")) return false;
  const url = new URL(path, "http://environment");
  return (
    (url.pathname === "/mcp" && ["POST", "DELETE"].includes(method)) ||
    (method === "POST" && url.pathname.startsWith("/api/attachments/upload/"))
  );
}
interface Channel {
  readonly source: WebSocket;
  readonly sourceId: string;
  readonly destination: WebSocket;
  readonly destinationId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Routes only enrolled sources; it stamps identity rather than accepting a supplied principal. */
export function createOrchestrationRouter(options: {
  readonly destination: (id: string) => WebSocket | undefined;
  readonly catalog: () => Promise<HubEnvironmentCatalog>;
}) {
  const destinations = new Map<string, Channel>();
  const sources = new Map<WebSocket, Map<string, Channel>>();
  const finish = (channel: Channel) => {
    clearTimeout(channel.timer);
    destinations.delete(channel.destinationId);
    const pending = sources.get(channel.source);
    pending?.delete(channel.sourceId);
    if (pending?.size === 0) sources.delete(channel.source);
  };
  const reject = (socket: WebSocket, id: string, status: number, message: string) => {
    sendFrame(socket, {
      type: "peer-http-head",
      id,
      status,
      headers: { "content-type": "text/plain" },
    });
    sendFrame(socket, {
      type: "peer-http-data",
      id,
      data: Buffer.from(message).toString("base64"),
    });
    sendFrame(socket, { type: "peer-http-end", id });
  };
  const handle = (socket: WebSocket, sourceEnvironmentId: string, frame: TunnelFrame): boolean => {
    if (frame.type === "peer-catalog") {
      void options.catalog().then(
        (catalog) => sendFrame(socket, { type: "peer-catalog-result", id: frame.id, catalog }),
        () => reject(socket, frame.id, 503, "Hub catalog unavailable"),
      );
      return true;
    }
    if (frame.type === "peer-http-open") {
      const pending = sources.get(socket) ?? new Map<string, Channel>();
      if (
        pending.has(frame.id) ||
        pending.size >= 128 ||
        !orchestrationPath(frame.method, frame.path)
      ) {
        reject(socket, frame.id, 403, "Invalid orchestration request");
        return true;
      }
      const destination = options.destination(frame.environmentId);
      if (!destination) {
        reject(socket, frame.id, 503, "Environment unavailable");
        return true;
      }
      const destinationId = NodeCrypto.randomUUID();
      const channel: Channel = {
        source: socket,
        sourceId: frame.id,
        destination,
        destinationId,
        timer: setTimeout(() => {
          reject(socket, frame.id, 504, "Orchestration request timed out");
          sendFrame(destination, { type: "cancel", id: destinationId });
          finish(channel);
        }, 60_000),
      };
      pending.set(frame.id, channel);
      sources.set(socket, pending);
      destinations.set(destinationId, channel);
      const headers = Object.fromEntries(
        Object.entries(frame.headers).filter(([key]) =>
          [
            "content-type",
            "accept",
            "mcp-session-id",
            "mcp-protocol-version",
            "t3-mode-limit",
          ].includes(key.toLowerCase()),
        ),
      );
      sendFrame(destination, {
        type: "http-open",
        id: destinationId,
        method: frame.method,
        path: frame.path,
        headers,
        principal: {
          sessionId: AuthSessionId.make(`hub-environment:${sourceEnvironmentId}`),
          subject: `hub-environment:${sourceEnvironmentId}`,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        },
      });
      return true;
    }
    if (
      frame.type === "peer-http-data" ||
      frame.type === "peer-http-end" ||
      frame.type === "peer-cancel"
    ) {
      const channel = sources.get(socket)?.get(frame.id);
      if (channel) {
        if (frame.type === "peer-http-data")
          sendFrame(channel.destination, {
            type: "http-data",
            id: channel.destinationId,
            data: frame.data,
          });
        else if (frame.type === "peer-http-end")
          sendFrame(channel.destination, { type: "http-end", id: channel.destinationId });
        else {
          sendFrame(channel.destination, { type: "cancel", id: channel.destinationId });
          finish(channel);
        }
      }
      return true;
    }
    if (!("id" in frame)) return false;
    const channel = destinations.get(frame.id);
    if (!channel || channel.destination !== socket) return false;
    if (frame.type === "http-head")
      sendFrame(channel.source, {
        type: "peer-http-head",
        id: channel.sourceId,
        status: frame.status,
        headers: frame.headers,
      });
    else if (frame.type === "http-data")
      sendFrame(channel.source, { type: "peer-http-data", id: channel.sourceId, data: frame.data });
    else if (frame.type === "http-end") {
      sendFrame(channel.source, { type: "peer-http-end", id: channel.sourceId });
      finish(channel);
    } else if (frame.type === "error") {
      reject(channel.source, channel.sourceId, 502, frame.message);
      finish(channel);
    } else return false;
    return true;
  };
  const disconnect = (socket: WebSocket) => {
    for (const channel of [...destinations.values()]) {
      if (channel.source === socket) {
        sendFrame(channel.destination, { type: "cancel", id: channel.destinationId });
        finish(channel);
      } else if (channel.destination === socket) {
        reject(channel.source, channel.sourceId, 503, "Environment unavailable");
        finish(channel);
      }
    }
  };
  return { handle, disconnect };
}
