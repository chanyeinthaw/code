import * as Option from "effect/Option";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  type AuthMcpClientAccess,
  type ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as McpOAuthHttp from "../auth/mcpOAuthHttp.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as HubEnvironments from "./HubEnvironments.ts";
import * as HubMcpClient from "./HubMcpClient.ts";

class PeerTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.metadata)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

export const descriptorOf = (
  environmentId: string,
  label: string,
  capabilities: Partial<ExecutionEnvironmentDescriptor["capabilities"]> = {},
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    mcpModeLimitHeader: true,
    ...capabilities,
  },
});

/**
 * The environment a link points at, as it runs: its descriptor, MCP OAuth,
 * and `/mcp` with `tools` behind the real client authenticator, on a real
 * socket. The descriptor can be swapped, as when its address comes to answer
 * as another environment, and every bearer it receives is recorded.
 */
export const servePeer = <E, R, E2 = never, R2 = never>(
  initial: ExecutionEnvironmentDescriptor,
  tools: Layer.Layer<never, E, R>,
  /** More routes the peer serves, such as attachment uploads. */
  routes: Layer.Layer<never, E2, R2> = Layer.empty as Layer.Layer<never, E2, R2>,
  /**
   * The peer's own config and secret store, when its tools need the same ones
   * its auth uses, as signed uploads do. A fresh pair otherwise.
   */
  base?: Context.Context<ServerConfig.ServerConfig | ServerSecretStore.ServerSecretStore>,
) =>
  Effect.gen(function* () {
    const descriptor = yield* Ref.make(initial);
    const bearers = yield* Ref.make<ReadonlyArray<string>>([]);
    const probes = yield* Ref.make(0);
    const layerEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Ref.get(descriptor).pipe(Effect.map((current) => current.environmentId)),
      getDescriptor: Ref.get(descriptor),
    });
    const layerBase =
      base === undefined
        ? ServerSecretStore.layer.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-peer-" }),
            ),
          )
        : Layer.succeedContext(base);
    const authContext = yield* EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(layerBase),
      Layer.provideMerge(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    const layerRecordBearers = HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/.well-known/t3/environment")) {
            yield* Ref.update(probes, (count) => count + 1);
          }
          const authorization = request.headers.authorization;
          if (authorization !== undefined) {
            yield* Ref.update(bearers, (seen) => [...seen, authorization]);
          }
          return yield* httpEffect;
        }),
      { global: true },
    );
    const layerRoutes = Layer.mergeAll(
      HttpApiBuilder.layer(PeerTestApi).pipe(
        Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
        Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
      ),
      tools.pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provide(
          Layer.effect(
            McpHttpServer.McpClientAuthenticator,
            Effect.gen(function* () {
              const auth = yield* EnvironmentAuth.EnvironmentAuth;
              return {
                authenticate: (request) =>
                  auth.authenticateMcpClient(request).pipe(
                    Effect.map((client): McpInvocationContext.McpInvocationScope => ({
                      environmentId: initial.environmentId,
                      requestNamespace: `client:${client.sessionId}`,
                      thread: undefined,
                      client: {
                        sessionId: client.sessionId,
                        label: client.label,
                        access: client.access,
                        hubEnvironment: true,
                      },
                      capabilities: new Set(["orchestration"]),
                      issuedAt: 0,
                    })),
                    Effect.orElseSucceed(() => undefined),
                  ),
              };
            }),
          ),
        ),
      ),
      routes,
    ).pipe(
      Layer.provide(layerRecordBearers),
      Layer.provide(layerEnvironment),
      Layer.provide(Layer.succeedContext(authContext)),
    );
    // Fresh, so the peer never shares a toolkit or MCP server with the
    // environment that links to it in the same test.
    yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.fresh,
      Layer.build,
    );
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const auth = Context.get(authContext, EnvironmentAuth.EnvironmentAuth);
    return {
      environmentId: initial.environmentId,
      label: initial.label,
      url,
      auth,
      descriptor,
      bearers,
      /** How often its descriptor was asked for, as a probe of whether it answers. */
      probes,
      /** The sessions linking created there, which its Connections lists. */
      linkedSessions: auth
        .listSessions()
        .pipe(
          Effect.map((sessions) =>
            sessions.filter((session) => session.client.label?.startsWith("T3 Code · ")),
          ),
        ),
    };
  });

export type ServedPeer = Effect.Success<ReturnType<typeof servePeer>>;

interface TestDestination {
  readonly peer: ServedPeer;
  readonly token: string;
  readonly access: AuthMcpClientAccess;
}
const outcomes = new WeakMap<
  HubEnvironments.HubEnvironments["Service"],
  Queue.Queue<string | null>
>();
const registries = new WeakMap<
  HubEnvironments.HubEnvironments["Service"],
  Map<EnvironmentId, TestDestination>
>();

/** Test enrolled destinations independently of the production hub transport. */
export const layerLinkingEnvironment = (descriptor: ExecutionEnvironmentDescriptor) => {
  const catalog = Layer.effect(
    HubEnvironments.HubEnvironments,
    Effect.gen(function* () {
      const observed = yield* Queue.unbounded<string | null>();
      const entries = new Map<EnvironmentId, TestDestination>();
      const summary = (
        id: EnvironmentId,
        entry: TestDestination,
      ): HubEnvironments.HubEnvironment => ({
        environmentId: id,
        label: entry.peer.label,
        status: "reachable",
        access: entry.access,
        lastError: null,
      });
      const service = HubEnvironments.HubEnvironments.of({
        list: Effect.sync(() => [...entries].map(([id, entry]) => summary(id, entry))),
        get: (id) =>
          Effect.sync(() => {
            const entry = entries.get(id);
            return entry === undefined ? Option.none() : Option.some(summary(id, entry));
          }),
        resolve: (id) =>
          Effect.gen(function* () {
            const entry = entries.get(id);
            if (!entry)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Environment not enrolled",
              });
            if ((yield* Ref.get(entry.peer.descriptor)).environmentId !== id)
              return yield* new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Environment unavailable",
              });
            return { link: summary(id, entry), url: entry.peer.url, token: entry.token };
          }),
        recordOutcome: (_id, outcome) => Queue.offer(observed, outcome.error).pipe(Effect.asVoid),
      });
      registries.set(service, entries);
      outcomes.set(service, observed);
      return service;
    }),
  );
  return HubMcpClient.layer.pipe(
    Layer.provideMerge(catalog),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(descriptor.environmentId),
        getDescriptor: Effect.succeed(descriptor),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
  );
};

/** Enroll the test destination; caller-mode propagation is exercised over its real MCP endpoint. */
export const linkTo = (
  links: HubEnvironments.HubEnvironments["Service"],
  peer: ServedPeer,
  access: AuthMcpClientAccess = "auto",
) =>
  peer.auth
    .issueMcpClientSession({
      access,
      label: "T3 Code · Laptop",
      client: { deviceType: "bot", label: "T3 Code · Laptop" },
    })
    .pipe(
      Effect.flatMap(({ token }) =>
        Effect.sync(() => {
          const registry = registries.get(links);
          if (!registry) throw new Error("Missing test catalog");
          registry.set(peer.environmentId, { peer, token, access });
        }),
      ),
    );
export const removeTestEnvironment = (
  links: HubEnvironments.HubEnvironments["Service"],
  id: EnvironmentId,
) => Effect.sync(() => registries.get(links)?.delete(id));

/** Waits for a real failed call before advancing the retry clock. */
export const waitForTestFailure = (service: HubEnvironments.HubEnvironments["Service"]) =>
  Effect.gen(function* () {
    const observed = outcomes.get(service);
    if (observed === undefined) return yield* Effect.die("Missing test outcomes");
    return yield* Queue.take(observed).pipe(Effect.repeat({ while: (error) => error === null }));
  });
