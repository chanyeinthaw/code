import { handleAgents, handleOneChat } from "../oneChat/http.ts";
import type * as OneChat from "../oneChat/OneChat.ts";
import * as HubAuth from "./HubAuth.ts";
import {
  handleHubAuth,
  hubRequestToken,
  sameOriginRequest,
  readHubRequestBody,
} from "./authHttp.ts";
import { HUB_INGRESS_HEADER } from "./ingress.ts";
import {
  EnvironmentId,
  HubSwitchInput,
  type HubSwitchInput as HubConnection,
  type HubConnectionState,
  HubLocalEnvironmentState,
  HubLocalEnvironmentInput,
  HubEnvironmentMoveInput,
} from "@t3tools/contracts";
import { proxyHubWebRequest, proxyHubWebSocket, makeHubWebHandler } from "./HubWeb.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Node streams and upgrades implement the raw multiplexed transport.
// @effect-diagnostics globalTimers:off -- Node transport callbacks own registration and request deadlines.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import WebSocket, { WebSocketServer } from "ws";
import {
  TunnelFrame,
  forwardHeaders,
  localPath,
  MAX_FRAME_BYTES,
  MAX_TUNNEL_BUFFER,
  sendFrame,
  sendHttpData,
} from "./protocol.ts";

export class HubTransportError extends Schema.TaggedError<HubTransportError>()(
  "HubTransportError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "The hub transport failed.";
  }
}

export interface HubListenOptions {
  readonly host: string;
  readonly port: number;
  readonly devUrl?: string;
  readonly publicOrigin?: string;
  readonly oneChat?: OneChat.OneChat["Service"];
  readonly staticDir?: string;
  readonly serveWeb?: boolean;
  readonly localPort?: number;
  readonly localEnvironment?: {
    readonly read: () => HubLocalEnvironmentState;
    readonly setEnabled: (enabled: boolean) => Promise<void>;
    readonly move: (input: HubEnvironmentMoveInput) => Promise<void>;
  };
  readonly connection?: {
    readonly read: () => HubConnectionState;
    readonly switch: (connection: HubConnection) => Promise<string | undefined>;
  };
}
export class HubServer extends Context.Service<
  HubServer,
  {
    readonly listen: (
      options: HubListenOptions,
    ) => Effect.Effect<
      { readonly port: number; readonly setRemoteHub: (url: string | null) => void },
      HubTransportError,
      import("effect/Scope").Scope | HubAuth.HubAuth
    >;
  }
>()("t3/hub/HubServer") {}

interface Peer {
  readonly sessionId: import("@t3tools/contracts").AuthSessionId;
  readonly moveSupported: boolean;
  readonly moves: Map<
    string,
    { resolve: (success: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >;
  readonly socket: WebSocket;
  readonly label: string;
  readonly http: Map<
    string,
    {
      readonly response: NodeHttp.ServerResponse;
      readonly request: NodeHttp.IncomingMessage;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >;
  readonly ws: Map<string, WebSocket>;
}

/** Each request carries its own environment address; browser tabs never share a machine selection. */
const route = (raw: string) => {
  const url = new URL(raw, "http://hub");
  const match = /^\/hub\/environments\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  try {
    return {
      environmentId: decodeURIComponent(match[1]!),
      path: `${match[2] ?? "/"}${url.search}`,
    };
  } catch {
    return null;
  }
};

const decodeConnection = Schema.decodeSync(Schema.fromJsonString(HubSwitchInput));

const decodeMove = Schema.decodeSync(Schema.fromJsonString(HubEnvironmentMoveInput));

const decodeLocalEnvironment = Schema.decodeSync(Schema.fromJsonString(HubLocalEnvironmentInput));

const isHubAuthError = Schema.is(HubAuth.HubAuthError);
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(TunnelFrame));

/** The hub owns connectivity; execution and durable worker threads remain on each environment. */
const listen = Effect.fn("HubServer.listen")(function* (options: HubListenOptions) {
  const auth = yield* HubAuth.HubAuth;
  const scope = yield* Effect.scope;
  const serveWeb =
    options.serveWeb !== false && !options.devUrl && options.staticDir
      ? yield* makeHubWebHandler(options.staticDir)
      : undefined;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HubAuth.HubAuth>());
  const watch = (
    sessionId: import("@t3tools/contracts").AuthSessionId,
    close: () => void,
    owner: {
      once: (event: "close", listener: () => void) => unknown;
      removeListener: (event: "close", listener: () => void) => unknown;
    },
  ) => {
    const closed = Effect.callback<boolean>((resume) => {
      const done = () => resume(Effect.succeed(false));
      owner.once("close", done);
      return Effect.sync(() => {
        owner.removeListener("close", done);
      });
    });
    void runPromise(
      Effect.raceFirst(auth.awaitInvalidation(sessionId).pipe(Effect.as(true)), closed).pipe(
        Effect.tap((revoked) => (revoked ? Effect.sync(close) : Effect.void)),
        Effect.forkIn(scope),
      ),
    );
  };
  let remoteHub: string | null = null;
  const peers = new Map<string, Peer>();
  const readCatalog = async () => {
    const enrolled = await runPromise(auth.listEnvironments);
    const labels = new Map(
      enrolled.map((session) => {
        const id = session.subject.slice("hub-daemon:".length);
        return [id, peers.get(id)?.label ?? session.client.label ?? id] as const;
      }),
    );
    return {
      environments: [...labels].map(([id, label]) => ({
        environmentId: EnvironmentId.make(id),
        label,
        connected: peers.has(id),
        ...(peers.get(id)?.moveSupported ? { moveSupported: true } : {}),
      })),
    };
  };
  const webSockets = new Set<WebSocket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const clients = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const server = NodeHttp.createServer(async (request, response) => {
    request.pause();
    try {
      const url = new URL(request.url ?? "/", "http://hub");
      if (url.pathname === "/hub/local-environment" && options.localEnvironment) {
        const environment = options.localEnvironment;
        if (request.method === "GET") {
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify(environment.read()));
        } else if (request.method === "PUT") {
          if (!sameOriginRequest(request, options.publicOrigin))
            throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
          await runPromise(auth.requireAdmin(hubRequestToken(request, auth.cookieName)));
          const parts: Buffer[] = [];
          let size = 0;
          request.on("data", (part: Buffer) => {
            size += part.length;
            if (size > 4096) request.destroy();
            else parts.push(part);
          });
          request.on("end", () => {
            let input: HubLocalEnvironmentInput;
            try {
              input = decodeLocalEnvironment(Buffer.concat(parts).toString());
            } catch {
              response.writeHead(400);
              response.end("Invalid local environment setting.");
              return;
            }
            void environment.setEnabled(input.enabled).then(
              () => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(environment.read()));
              },
              () => {
                response.writeHead(400);
                response.end("Could not change local environment.");
              },
            );
          });
          request.on("error", () => response.destroy());
          request.resume();
        } else {
          response.writeHead(405);
          response.end();
        }
        return;
      }
      if (url.pathname === "/hub/local-environment/connection" && options.localEnvironment) {
        if (request.method !== "PUT") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (!sameOriginRequest(request, options.publicOrigin))
          throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
        await runPromise(auth.requireAdmin(hubRequestToken(request, auth.cookieName)));
        let input: HubEnvironmentMoveInput;
        try {
          input = decodeMove(await runPromise(readHubRequestBody(request)));
        } catch {
          throw new HubAuth.HubAuthError({ status: 400, cause: "Invalid environment hub target" });
        }
        try {
          await options.localEnvironment.move(input);
        } catch {
          throw new HubAuth.HubAuthError({
            status: 400,
            cause: "Could not move local environment",
          });
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(options.localEnvironment.read()));
        return;
      }
      if (url.pathname === "/hub/connection" && options.connection) {
        const connection = options.connection;
        if (request.method === "GET") {
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(JSON.stringify(connection.read()));
        } else if (request.method === "PUT") {
          if (!sameOriginRequest(request, options.publicOrigin))
            throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
          await runPromise(auth.requireAdmin(hubRequestToken(request, auth.cookieName)));
          const parts: Buffer[] = [];
          let size = 0;
          request.on("data", (part: Buffer) => {
            size += part.length;
            if (size > 4096) request.destroy();
            else parts.push(part);
          });
          request.on("end", () => {
            let input: HubConnection;
            try {
              input = decodeConnection(Buffer.concat(parts).toString());
              if (input.hubUrl && new URL(input.hubUrl).host === request.headers.host) {
                throw new Error("Use the local hub option for this installation.");
              }
            } catch {
              response.writeHead(400);
              response.end("Invalid hub URL.");
              return;
            }
            void connection.switch(input).then(
              (cookie) => {
                if (cookie)
                  response.setHeader(
                    "set-cookie",
                    cookie +
                      (request.headers.origin?.startsWith("https:") ||
                      request.headers["x-forwarded-proto"] === "https"
                        ? "; Secure"
                        : ""),
                  );
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(connection.read()));
              },
              () => {
                response.writeHead(400);
                response.end("Could not switch hubs.");
              },
            );
          });
          request.on("error", () => response.destroy());
          request.resume();
        } else {
          response.writeHead(405);
          response.end();
        }
        return;
      }
      // Legacy discovery can describe the running local environment on either hub.
      if (
        url.pathname === "/.well-known/t3/environment" &&
        options.localPort &&
        (options.localEnvironment?.read().enabled ?? true)
      ) {
        proxyHubWebRequest(request, response, `http://127.0.0.1:${options.localPort}`);
        return;
      }
      if (
        url.pathname === "/hub/local-auth/pair" ||
        url.pathname === "/hub/local-auth/session" ||
        url.pathname === "/hub/local-auth/leave" ||
        url.pathname === "/hub/local-auth/client-access"
      ) {
        await runPromise(
          handleHubAuth(
            request,
            response,
            url.pathname.replace("/hub/local-auth/", "/hub/auth/"),
            options.publicOrigin,
          ),
        );
        return;
      }
      // Pairing-free entry applies only to this deployment's served client, never a remote selection.
      if (
        ["/hub/auth/open", "/hub/auth/client-access"].includes(url.pathname) &&
        (remoteHub || (!options.staticDir && !options.devUrl))
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (remoteHub && (url.pathname === "/hub" || url.pathname.startsWith("/hub/"))) {
        if (!sameOriginRequest(request, options.publicOrigin))
          throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
        // The gateway validates browser Origin; the destination receives an authenticated proxy request.
        if (request.headers.origin?.startsWith("https:"))
          request.headers["x-forwarded-proto"] = "https";
        delete request.headers.origin;
        // The installation's own admin session must never be sent to the destination hub.
        request.headers.cookie = request.headers.cookie
          ?.split(";")
          .filter(
            (p) =>
              !p.trim().startsWith(`${auth.cookieName}=`) &&
              !p.trim().startsWith("t3_dev_session_"),
          )
          .join(";");
        delete request.headers[HUB_INGRESS_HEADER];
        proxyHubWebRequest(request, response, remoteHub);
        return;
      }
      if (url.pathname === "/hub/agents" && options.oneChat) {
        await runPromise(handleAgents(request, response, options.oneChat, options.publicOrigin));
        return;
      }
      if (url.pathname === "/hub/one-chat" && options.oneChat) {
        await runPromise(handleOneChat(request, response, options.oneChat, options.publicOrigin));
        return;
      }
      if (url.pathname.startsWith("/hub/auth/")) {
        await runPromise(handleHubAuth(request, response, url.pathname, options.publicOrigin));
        return;
      }
      if (url.pathname === "/hub/environments") {
        await runPromise(auth.authenticate(hubRequestToken(request, auth.cookieName)));
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify(await readCatalog()));
        return;
      }
      const target = route(request.url ?? "/");
      if (!target) {
        // The hub serves the normal T3 web app, independently of execution environments.
        if (
          ["/api", "/ws", "/oauth", "/mcp", "/.well-known"].some(
            (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
          )
        ) {
          response.writeHead(400);
          response.end("An environment route is required.");
          return;
        }
        if (options.serveWeb === false) {
          response.writeHead(404);
          response.end(
            "This hub does not serve a client. Use pulse serve --no-environment or pulse client --hub <url>.",
          );
          return;
        }
        if (options.devUrl) proxyHubWebRequest(request, response, options.devUrl);
        else if (serveWeb) serveWeb(request, response);
        else {
          response.writeHead(503);
          response.end("Build the web app or configure --dev-url.");
        }
        return;
      }
      if (new URL(target.path, "http://environment").pathname === "/connection") {
        if (request.method !== "PUT") {
          response.writeHead(405);
          response.end();
          return;
        }
        if (!sameOriginRequest(request, options.publicOrigin))
          throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
        await runPromise(auth.requireAdmin(hubRequestToken(request, auth.cookieName)));
        const peer = peers.get(target.environmentId);
        if (!peer?.moveSupported)
          throw new HubAuth.HubAuthError({ status: 409, cause: "Environment cannot move" });
        let input: HubEnvironmentMoveInput;
        try {
          input = decodeMove(await runPromise(readHubRequestBody(request)));
        } catch {
          throw new HubAuth.HubAuthError({ status: 400, cause: "Invalid environment hub target" });
        }
        if (input.hubUrl) {
          let destination: URL;
          try {
            destination = new URL(input.hubUrl);
          } catch {
            throw new HubAuth.HubAuthError({ status: 400, cause: "Invalid hub URL" });
          }
          if (
            destination.host === request.headers.host ||
            destination.origin === options.publicOrigin
          )
            throw new HubAuth.HubAuthError({
              status: 400,
              cause: "Environment already uses this hub",
            });
        }
        const id = NodeCrypto.randomUUID();
        const success = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            peer.moves.delete(id);
            resolve(false);
          }, 25_000);
          peer.moves.set(id, { resolve, timer });
          if (!sendFrame(peer.socket, { type: "environment-move", id, input })) {
            clearTimeout(timer);
            peer.moves.delete(id);
            resolve(false);
          }
        });
        if (!success)
          throw new HubAuth.HubAuthError({ status: 400, cause: "Could not move environment" });
        // The environment retires its source credential after the new link is ready.
        await runPromise(auth.awaitInvalidation(peer.sessionId).pipe(Effect.timeout("10 seconds")));
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end("{}");
        return;
      }
      if (target.path.startsWith("/api/auth/websocket-ticket")) {
        await runPromise(
          handleHubAuth(request, response, "/api/auth/websocket-ticket", options.publicOrigin),
        );
        return;
      }
      if (target.path.startsWith("/mcp") || target.path.startsWith("/oauth/token"))
        throw new HubAuth.HubAuthError({
          status: 403,
          cause: "Hub client sessions cannot authorize MCP clients",
        });
      const session = await runPromise(
        auth.authenticate(hubRequestToken(request, auth.cookieName)),
      );
      if (request.method !== "GET" && !sameOriginRequest(request, options.publicOrigin))
        throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
      const peer = peers.get(target.environmentId);
      if (!peer) {
        response.writeHead(503);
        response.end("Environment unavailable");
        return;
      }
      const id = NodeCrypto.randomUUID();
      const timer = setTimeout(() => {
        if (!response.headersSent) response.writeHead(504);
        response.end();
        peer.http.delete(id);
        sendFrame(peer.socket, { type: "cancel", id });
      }, 60_000);
      peer.http.set(id, { request, response, timer });
      watch(session.sessionId, () => response.destroy(), response);
      // Pairing entry points are retained in the environment source but disconnected from hub access.
      if (
        new URL(target.path, "http://environment").pathname.startsWith("/api/auth/") &&
        new URL(target.path, "http://environment").pathname !== "/api/auth/session"
      ) {
        clearTimeout(timer);
        peer.http.delete(id);
        response.writeHead(410);
        response.end("Manage access through the hub.");
        return;
      }
      sendFrame(peer.socket, {
        type: "http-open",
        id,
        method: request.method ?? "GET",
        path: target.path,
        headers: Object.fromEntries(
          Object.entries(forwardHeaders(request.headers)).filter(
            ([key]) => !["authorization", "cookie", HUB_INGRESS_HEADER].includes(key.toLowerCase()),
          ),
        ),
        principal: {
          sessionId: session.sessionId,
          subject: session.subject,
          scopes: session.scopes,
        },
      });
      request.on("data", (chunk: Buffer) => sendHttpData(peer.socket, id, chunk));
      request.on("end", () => sendFrame(peer.socket, { type: "http-end", id }));
      response.on("close", () => {
        clearTimeout(timer);
        peer.http.delete(id);
        sendFrame(peer.socket, { type: "cancel", id });
      });
      request.on("error", () => response.destroy());
    } catch (error) {
      if (!response.headersSent)
        response.writeHead(isHubAuthError(error) ? error.status : 500, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
      response.end(
        JSON.stringify({
          message: isHubAuthError(error) ? error.message : "Hub request failed.",
        }),
      );
    } finally {
      request.resume();
    }
  });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://hub");
      if (!sameOriginRequest(request, options.publicOrigin))
        throw new HubAuth.HubAuthError({ status: 403, cause: "Origin mismatch" });
      if (
        remoteHub &&
        requestUrl.pathname.startsWith("/hub/") &&
        requestUrl.pathname !== "/hub/daemon"
      ) {
        // Client routing is independent of the owned hub's outbound environment links.
        delete request.headers.origin;
        request.headers.cookie = request.headers.cookie
          ?.split(";")
          .filter(
            (p) =>
              !p.trim().startsWith(`${auth.cookieName}=`) &&
              !p.trim().startsWith("t3_dev_session_"),
          )
          .join(";");
        delete request.headers[HUB_INGRESS_HEADER];
        clients.handleUpgrade(request, socket, head, (client) =>
          proxyHubWebSocket(client, request, remoteHub!, webSockets),
        );
        return;
      }
      if (requestUrl.pathname === "/hub/daemon") {
        const environmentId = requestUrl.searchParams.get("environmentId") ?? "";
        const machine = await runPromise(
          auth.authenticateEnvironment(hubRequestToken(request, auth.cookieName), environmentId),
        );
        sockets.handleUpgrade(request, socket, head, (tunnel) => {
          watch(machine.sessionId, () => tunnel.close(1008, "Machine credential revoked"), tunnel);
          sockets.emit("connection", tunnel, request);
          let registered: { id: string; peer: Peer } | undefined;
          const deadline = setTimeout(() => tunnel.close(1008, "Registration required"), 10_000);
          tunnel.on("error", () => tunnel.terminate());
          tunnel.on("message", (data) => {
            const decoded = decodeFrame(data.toString());
            if (decoded._tag === "None") {
              tunnel.close(1008, "Invalid tunnel frame");
              return;
            }
            const frame = decoded.value;
            if (!registered) {
              if (
                frame.type !== "register" ||
                !frame.environmentId ||
                frame.environmentId !== environmentId ||
                frame.environmentId.length > 200 ||
                frame.label.length > 200
              ) {
                tunnel.close(1008, "Registration required");
                return;
              }
              if (peers.has(frame.environmentId)) {
                tunnel.close(1008, "Environment already connected");
                return;
              }
              clearTimeout(deadline);
              const peer: Peer = {
                sessionId: machine.sessionId,
                moveSupported: frame.moveSupported ?? false,
                moves: new Map(),
                socket: tunnel,
                label: frame.label,
                http: new Map(),
                ws: new Map(),
              };
              peers.set(frame.environmentId, peer);
              registered = { id: frame.environmentId, peer };
              sendFrame(tunnel, { type: "registered" });
              return;
            }
            const { peer } = registered;
            const pending = "id" in frame ? peer.http.get(frame.id) : undefined;
            const client = "id" in frame ? peer.ws.get(frame.id) : undefined;
            switch (frame.type) {
              case "environment-move-result": {
                const move = peer.moves.get(frame.id);
                if (move) {
                  clearTimeout(move.timer);
                  peer.moves.delete(frame.id);
                  move.resolve(frame.success);
                }
                break;
              }
              case "http-head":
                if (pending) {
                  clearTimeout(pending.timer);
                  pending.response.writeHead(frame.status, forwardHeaders(frame.headers));
                }
                break;
              case "http-data":
                if (pending && !pending.response.destroyed) {
                  pending.response.write(Buffer.from(frame.data, "base64"));
                  if (pending.response.writableLength > MAX_TUNNEL_BUFFER)
                    pending.response.destroy();
                }
                break;
              case "http-end":
                pending?.response.end();
                break;
              case "error":
                if (pending) {
                  if (!pending.response.headersSent) pending.response.writeHead(502);
                  pending.response.end(frame.message);
                }
                client?.close(1011, "Environment request failed");
                break;
              case "ws-data":
                if (client?.readyState === WebSocket.OPEN) {
                  if (client.bufferedAmount > MAX_TUNNEL_BUFFER)
                    client.close(1013, "Client overloaded");
                  else client.send(Buffer.from(frame.data, "base64"), { binary: frame.binary });
                }
                break;
              case "ws-close":
                client?.close();
                break;
            }
          });
          tunnel.on("close", () => {
            clearTimeout(deadline);
            if (!registered) return;
            for (const move of registered.peer.moves.values()) {
              clearTimeout(move.timer);
              move.resolve(false);
            }
            registered.peer.moves.clear();
            if (peers.get(registered.id) === registered.peer) peers.delete(registered.id);
            for (const { response, timer } of registered.peer.http.values()) {
              clearTimeout(timer);
              if (!response.headersSent) response.writeHead(503);
              response.end();
            }
            for (const client of registered.peer.ws.values())
              client.close(1012, "Environment disconnected");
          });
        });
        return;
      }
      const target = route(request.url ?? "/");
      if (
        !target &&
        options.devUrl &&
        request.headers["sec-websocket-protocol"]
          ?.split(",")
          .map((value) => value.trim())
          .includes("vite-hmr")
      ) {
        clients.handleUpgrade(request, socket, head, (client) =>
          proxyHubWebSocket(client, request, options.devUrl!, webSockets),
        );
        return;
      }
      const peer = target ? peers.get(target.environmentId) : undefined;
      if (!peer || !target || !localPath(target.path)) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      const ticket = requestUrl.searchParams.get("wsTicket");
      const session = ticket
        ? await runPromise(auth.verifyTicket(ticket))
        : await runPromise(auth.authenticate(hubRequestToken(request, auth.cookieName)));
      if (session.subject.startsWith("hub-daemon:") || session.subject === "mcp-client")
        throw new HubAuth.HubAuthError({ status: 401, cause: "Wrong audience" });
      clients.handleUpgrade(request, socket, head, (client) => {
        watch(session.sessionId, () => client.close(1008, "Hub session revoked"), client);
        void runPromise(auth.markConnected(session.sessionId));
        const id = NodeCrypto.randomUUID();
        peer.ws.set(id, client);
        sendFrame(peer.socket, {
          type: "ws-open",
          id,
          path: target.path,
          principal: {
            sessionId: session.sessionId,
            subject: session.subject,
            scopes: session.scopes,
          },
          protocols:
            request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim()) ??
            [],
        });
        client.on("message", (data, binary) =>
          sendFrame(peer.socket, {
            type: "ws-data",
            id,
            data: Buffer.from(
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : data,
            ).toString("base64"),
            binary,
          }),
        );
        client.on("error", () => client.terminate());
        client.on("close", () => {
          peer.ws.delete(id);
          void runPromise(auth.markDisconnected(session.sessionId));
          sendFrame(peer.socket, { type: "ws-close", id });
        });
      });
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${isHubAuthError(error) ? error.status : 401} Unauthorized\r\nConnection: close\r\n\r\n`,
      );
    }
  });
  // Terminate dead outbound links so environments retry instead of keeping stale machines listed.
  const alive = new WeakSet<WebSocket>();
  sockets.on("connection", (socket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
  });
  yield* Effect.sync(() => {
    for (const socket of sockets.clients) {
      if (!alive.has(socket)) socket.terminate();
      else {
        alive.delete(socket);
        socket.ping();
      }
    }
  }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const socket of webSockets) socket.terminate();
      for (const client of clients.clients) client.terminate();
      for (const tunnel of sockets.clients) tunnel.terminate();
      clients.close();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  const port = yield* Effect.tryPromise({
    try: () =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          const address = server.address();
          if (address && typeof address !== "string") resolve(address.port);
          else reject(new Error("Missing listener"));
        });
      }),
    catch: (cause) => new HubTransportError({ cause }),
  });
  return {
    port,
    setRemoteHub: (url: string | null) => {
      if (url === remoteHub) return;
      remoteHub = url;
      for (const client of clients.clients) client.close(1012, "Hub changed");
      for (const socket of webSockets) socket.terminate();
    },
  };
});

export const layer = Layer.succeed(HubServer, HubServer.of({ listen }));
