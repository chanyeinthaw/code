// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off -- Exercise real enrolled tunnels and the private HTTP gateway.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NetService from "@t3tools/shared/Net";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "./HubAuth.ts";
import * as HubServer from "./HubServer.ts";
import { connectEnvironment } from "./EnvironmentTunnel.ts";
import { HUB_INGRESS_HEADER, verifyHubIngress } from "./ingress.ts";
import { orchestrationPath } from "./OrchestrationRouter.ts";

it("permits only MCP and signed upload routes for environment-originated calls", () => {
  expect(orchestrationPath("POST", "/mcp")).toBe(true);
  expect(orchestrationPath("POST", "/api/attachments/upload/signed-token")).toBe(true);
  for (const path of [
    "/api/auth/pairing-token",
    "/oauth/token",
    "//elsewhere/mcp",
    "/mcp/../api/auth/session",
    "/api/attachments/upload/../../auth/session",
  ])
    expect(orchestrationPath("POST", path)).toBe(false);
  expect(orchestrationPath("GET", "/mcp")).toBe(false);
});

it.effect(
  "discovers enrolled environments, routes MCP with source identity, and reports a disconnected destination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* HubAuth.HubAuth;
        const hub = yield* HubServer.HubServer;
        const net = yield* NetService.NetService;
        const sourcePort = yield* net.reserveLoopbackPort();
        const waiting = Promise.withResolvers<void>();
        const secret = "destination-test-secret";
        const local = NodeHttp.createServer((request, response) => {
          const header = request.headers[HUB_INGRESS_HEADER];
          const principal = verifyHubIngress(
            secret,
            typeof header === "string" ? header : undefined,
            request.method ?? "POST",
            request.url ?? "/",
          );
          if (!principal) {
            response.writeHead(401);
            response.end();
            return;
          }
          if (request.headers["mcp-session-id"] === "wait") {
            waiting.resolve();
            return;
          }
          const parts: Buffer[] = [];
          request.on("data", (part: Buffer) => parts.push(part));
          request.on("end", () => {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                principal,
                limit: request.headers["t3-mode-limit"],
                bearer: request.headers.authorization ?? null,
                body: Buffer.concat(parts).toString(),
              }),
            );
          });
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve)),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            local.closeAllConnections();
            local.close();
          }),
        );
        const address = local.address();
        if (!address || typeof address === "string")
          return yield* Effect.die("No destination port");
        yield* auth.enrollLocal("offline", "Offline");
        const listener = yield* hub.listen({ host: "127.0.0.1", port: 0 });
        const origin = `http://127.0.0.1:${listener.port}`;
        const sourceReady = Promise.withResolvers<void>();
        const destinationReady = Promise.withResolvers<void>();
        const destination = yield* connectEnvironment({
          hubUrl: origin,
          localPort: address.port,
          environmentId: "oxygen",
          label: "oxygen",
          credential: (yield* auth.enrollLocal("oxygen", "oxygen")).token,
          ingressSecret: secret,
          onRegistered: destinationReady.resolve,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* connectEnvironment({
          hubUrl: origin,
          localPort: 1,
          environmentId: "silicon",
          label: "silicon",
          credential: (yield* auth.enrollLocal("silicon", "silicon")).token,
          ingressSecret: "source-test-secret",
          orchestrationPort: sourcePort,
          onRegistered: sourceReady.resolve,
        }).pipe(Effect.scoped, Effect.forkScoped);
        yield* Effect.promise(() => sourceReady.promise);
        yield* Effect.promise(() => destinationReady.promise);
        const gateway = `http://127.0.0.1:${sourcePort}`;
        const headers = { authorization: "Bearer source-test-secret" };
        const catalog = yield* Effect.promise(async () =>
          (await fetch(`${gateway}/hub/environments`, { headers })).json(),
        );
        expect(catalog).toMatchObject({
          environments: expect.arrayContaining([
            { environmentId: "oxygen", label: "oxygen", connected: true },
            { environmentId: "offline", label: "Offline", connected: false },
          ]),
        });
        expect((yield* Effect.promise(() => fetch(`${gateway}/hub/environments`))).status).toBe(
          401,
        );
        const result = yield* Effect.promise(async () =>
          (
            await fetch(`${gateway}/hub/environments/oxygen/mcp`, {
              method: "POST",
              headers: {
                ...headers,
                "content-type": "application/json",
                "t3-mode-limit": "approval-required/plan",
              },
              body: '{"method":"tools/call"}',
            })
          ).json(),
        );
        expect(result).toMatchObject({
          principal: {
            subject: "hub-environment:silicon",
            sessionId: "hub-environment:silicon",
            scopes: ["orchestration:read", "orchestration:operate"],
          },
          limit: "approval-required/plan",
          bearer: null,
          body: '{"method":"tools/call"}',
        });
        expect(
          (yield* Effect.promise(() =>
            fetch(`${gateway}/hub/environments/oxygen/api/auth/pairing-token`, {
              method: "POST",
              headers,
            }),
          )).status,
        ).toBe(403);
        const inFlight = yield* Effect.promise(() =>
          fetch(`${gateway}/hub/environments/oxygen/mcp`, {
            method: "POST",
            headers: { ...headers, "mcp-session-id": "wait" },
            body: "{}",
          }),
        ).pipe(Effect.forkScoped);
        yield* Effect.promise(() => waiting.promise);
        yield* Fiber.interrupt(destination);
        expect((yield* Fiber.join(inFlight)).status).toBe(503);
      }),
    ).pipe(
      Effect.provide(HubServer.layer),
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            return HubAuth.layer(yield* ServerConfig.ServerConfig);
          }),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "pulse-cross-environment-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.provide(NetService.layer),
      Effect.provide(NodeServices.layer),
    ),
);
