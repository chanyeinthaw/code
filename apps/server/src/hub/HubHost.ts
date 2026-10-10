import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resolveServerEnvironmentLabel } from "../environment/ServerEnvironmentLabel.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as OneChat from "../oneChat/OneChat.ts";
import * as HubAuth from "./HubAuth.ts";
import * as Crypto from "effect/Crypto";
import { HubSwitchInput, type HubEnvironmentMoveInput } from "@t3tools/contracts";
import {
  ExecutionEnvironmentDescriptor,
  HubConnection,
  HubEnvironmentCatalog,
  HubLocalEnvironmentInput,
} from "@t3tools/contracts";
import { ensureTailscaleServe, disableTailscaleServe } from "@t3tools/tailscale";
import { ChildProcessSpawner } from "effect/process";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpBody } from "effect/http";
import * as ServerConfig from "../config.ts";
import { runServer } from "../server.ts";
import * as HubServer from "./HubServer.ts";
import {
  openEnvironmentConnection,
  readEnvironmentConnection,
  saveEnvironmentConnection,
} from "./EnvironmentConnection.ts";

const decodeEnvironmentSetting = Schema.decodeUnknownEffect(
  Schema.fromJsonString(HubLocalEnvironmentInput),
);
const encodeEnvironmentSetting = Schema.encodeEffect(
  Schema.fromJsonString(HubLocalEnvironmentInput),
);
const encodeListener = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String, port: Schema.Number })),
);

const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(HubConnection));
const encodeConnection = Schema.encodeEffect(Schema.fromJsonString(HubConnection));

type HostMode =
  | { readonly mode: "serve"; readonly environment: boolean }
  | { readonly mode: "client"; readonly hubUrl: string };

export class HubHost extends Context.Service<
  HubHost,
  {
    readonly run: (
      config: ServerConfig.ServerConfig["Service"],
      options?: HostMode,
    ) => Effect.Effect<never, HubServer.HubTransportError, Scope.Scope>;
  }
>()("t3/hub/HubHost") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hub = yield* HubServer.HubServer;
  const client = yield* HttpClient.HttpClient;

  const run = Effect.fn("HubHost.run")(
    function* (
      config: ServerConfig.ServerConfig["Service"],
      options: HostMode = { mode: "serve", environment: true },
    ) {
      const auth = yield* HubAuth.HubAuth;
      const oneChat = yield* OneChat.OneChat;
      const ingressSecret = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
      const localPort = options.mode === "serve" ? yield* net.reserveLoopbackPort() : undefined;
      const ownedEnvironment =
        options.mode === "serve"
          ? yield* Effect.gen(function* () {
              const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
              return {
                environmentId: yield* identity.getEnvironmentId,
                label: yield* resolveServerEnvironmentLabel({
                  cwdBaseName: path.basename(config.cwd).trim(),
                }).pipe(
                  Effect.provide(ProcessRunner.layer),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                ),
              };
            }).pipe(
              Effect.provide(ServerEnvironment.layerIdentity),
              Effect.provideService(ServerConfig.ServerConfig, config),
              Effect.provideService(Crypto.Crypto, crypto),
            )
          : undefined;
      const environmentSettingPath = path.join(config.stateDir, "hub-local-environment.json");
      const initiallyEnabled =
        options.mode === "serve" &&
        ((yield* fs.exists(environmentSettingPath))
          ? (yield* decodeEnvironmentSetting(yield* fs.readFileString(environmentSettingPath)))
              .enabled
          : options.environment);
      let environmentScope: Scope.Closeable | undefined;
      const connectionPath = path.join(config.stateDir, "hub-connection.json");
      let connection: HubConnection = { hubUrl: null };
      if (options.mode === "client") connection = { hubUrl: options.hubUrl };
      else if (yield* fs.exists(connectionPath)) {
        connection = yield* fs
          .readFileString(connectionPath)
          .pipe(Effect.flatMap(decodeConnection));
      }
      const context = yield* Effect.context<
        Scope.Scope | HubAuth.HubAuth | FileSystem.FileSystem | HttpClient.HttpClient
      >();
      const runPromise = Effect.runPromiseWith(context);
      const lock = yield* Semaphore.make(1);
      const initialized = yield* Deferred.make<void>();
      const savedEnvironmentConnection = yield* readEnvironmentConnection(config.stateDir);
      let environmentConnection = savedEnvironmentConnection ?? connection;
      // Preserve existing installations' environment target independently of client switches.
      if (options.mode === "serve" && savedEnvironmentConnection === undefined)
        yield* saveEnvironmentConnection(config.stateDir, environmentConnection);
      let environmentLink: Effect.Success<ReturnType<typeof openEnvironmentConnection>> | undefined;
      let descriptor: ExecutionEnvironmentDescriptor | undefined;
      const listener = yield* hub.listen({
        host: config.host ?? "127.0.0.1",
        port: config.port,
        oneChat,
        ...(config.publicUrl ? { publicOrigin: config.publicUrl.origin } : {}),
        ...(localPort === undefined ? {} : { localPort }),
        ...(config.devUrl ? { devUrl: config.devUrl.toString() } : {}),
        ...(config.staticDir ? { staticDir: config.staticDir } : {}),
        localEnvironment: {
          read: () => ({
            supported: options.mode === "serve",
            enabled: environmentScope !== undefined,
            ...ownedEnvironment,
            hubUrl: environmentConnection.hubUrl,
          }),
          move: (input): Promise<void> =>
            runPromise(
              Deferred.await(initialized).pipe(Effect.andThen(() => moveLocalEnvironment(input))),
            ),
          setEnabled: (enabled): Promise<void> =>
            runPromise(
              Deferred.await(initialized).pipe(
                Effect.andThen(() => setEnvironmentEnabled(enabled)),
              ),
            ),
        },
        connection: {
          read: () => ({
            ...connection,
            localHubAvailable: options.mode === "serve",
            localEnvironmentAvailable: environmentScope !== undefined,
            localDaemonAvailable: environmentScope !== undefined,
          }),
          switch: (next): Promise<string | undefined> =>
            runPromise(Deferred.await(initialized).pipe(Effect.andThen(() => switchHub(next)))),
        },
      });
      yield* Effect.addFinalizer(() => Deferred.interrupt(initialized));
      if (config.tailscaleServeEnabled) {
        yield* ensureTailscaleServe({
          localPort: listener.port,
          servePort: config.tailscaleServePort,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        yield* Effect.addFinalizer(() =>
          disableTailscaleServe({ servePort: config.tailscaleServePort }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.ignoreCause({ log: true }),
          ),
        );
      }
      const localHub = `http://127.0.0.1:${listener.port}`;

      const normalize = (input: HubConnection) =>
        Effect.try({
          try: () => {
            if (input.hubUrl === null) {
              if (options.mode === "client")
                throw new Error("Client-only mode requires a remote hub.");
              return input;
            }
            const url = new URL(input.hubUrl);
            if (
              !["http:", "https:"].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.pathname !== "/" ||
              url.search ||
              url.hash ||
              (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
                Number(url.port) === listener.port)
            ) {
              throw new Error("Use an HTTP or HTTPS hub origin, or select the local hub.");
            }
            return { hubUrl: url.origin };
          },
          catch: (cause) => new HubServer.HubTransportError({ cause }),
        });
      const switchHub = Effect.fn("HubHost.switch")(function* (input: typeof HubSwitchInput.Type) {
        const next = yield* normalize(input);
        if (next.hubUrl === connection.hubUrl) return;
        let browserCookie: string | undefined;
        if (next.hubUrl) {
          if (!input.pairingCode)
            throw new Error("A pairing code from the destination hub is required.");
          const paired = yield* client
            .post(`${next.hubUrl}/hub/auth/pair`, {
              body: HttpBody.jsonUnsafe({ credential: input.pairingCode }),
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(
                  Schema.Struct({ token: Schema.String, cookieName: Schema.String }),
                ),
              ),
              Effect.timeout("5 seconds"),
            );
          yield* client
            .get(`${next.hubUrl}/hub/environments`, {
              headers: { authorization: `Bearer ${paired.token}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap(HttpClientResponse.schemaBodyJson(HubEnvironmentCatalog)),
              Effect.timeout("5 seconds"),
            );
          browserCookie = `${paired.cookieName}=${paired.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
        }
        const previous = connection;
        yield* Effect.gen(function* () {
          listener.setRemoteHub(next.hubUrl);
          yield* fs.makeDirectory(config.stateDir, { recursive: true });
          yield* fs.writeFileString(`${connectionPath}.tmp`, yield* encodeConnection(next));
          yield* fs.rename(`${connectionPath}.tmp`, connectionPath);
          connection = next;
        }).pipe(Effect.tapError(() => Effect.sync(() => listener.setRemoteHub(previous.hubUrl))));
        return browserCookie;
      }, lock.withPermit);

      const stopEnvironment = Effect.fn("HubHost.stopEnvironment")(function* () {
        environmentLink = undefined;
        if (environmentScope) {
          yield* Scope.close(environmentScope, Exit.void);
          environmentScope = undefined;
        }
        descriptor = undefined;
      });
      yield* Effect.addFinalizer(stopEnvironment);

      const startEnvironment = Effect.fn("HubHost.startEnvironment")(
        function* (waitForRegistration: boolean) {
          if (environmentScope) return;
          if (localPort === undefined)
            throw new Error("This listener does not host an environment.");
          environmentScope = yield* Scope.make();
          const environmentConfig = {
            ...config,
            port: localPort,
            host: "127.0.0.1",
            noBrowser: true,
            noAuth: false,
            hubIngressSecret: ingressSecret,
            staticDir: undefined,
            devUrl: undefined,
            tailscaleServeEnabled: false,
          };
          const environment = yield* runServer.pipe(
            Effect.provideService(ServerConfig.ServerConfig, environmentConfig),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.forkIn(environmentScope),
          );
          descriptor = yield* Effect.raceFirst(
            client
              .get(`http://127.0.0.1:${localPort}/.well-known/t3/environment`)
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
                Effect.timeout("3 seconds"),
                Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
              ),
            Fiber.join(environment),
          );
          const runningDescriptor = descriptor;
          environmentLink = yield* openEnvironmentConnection({
            stateDir: config.stateDir,
            initial: environmentConnection,
            ownedHub: localHub,
            localPort,
            descriptor,
            ingressSecret,
              enrollOwned: () =>
              auth.enrollLocal(runningDescriptor.environmentId, runningDescriptor.label).pipe(
                Effect.map((session) => session.token),
                Effect.mapError((cause) => new HubServer.HubTransportError({ cause })),
              ),
            onSelected: (next) => {
              environmentConnection = next;
            },
          }).pipe(Effect.provideService(Scope.Scope, environmentScope));
          if (
            environmentConnection.hubUrl &&
            !environmentLink.hasCredential(environmentConnection)
          ) {
            yield* Effect.logWarning(
              "Enroll this environment through Hub settings to connect it to a hub.",
            );
          } else {
            yield* environmentLink.start(
              waitForRegistration || environmentConnection.hubUrl === null,
            );
          }
        },
        (effect, _waitForRegistration: boolean) =>
          effect.pipe(Effect.tapCause(() => stopEnvironment())),
      );

      const setEnvironmentEnabled = Effect.fn("HubHost.setEnvironmentEnabled")(function* (
        enabled: boolean,
      ) {
        if (options.mode !== "serve")
          throw new Error("This listener does not host an environment.");
        const previous = environmentScope !== undefined;
        yield* Effect.gen(function* () {
          if (enabled !== previous) {
            if (enabled) yield* startEnvironment(true);
            else yield* stopEnvironment();
          }
          yield* fs.makeDirectory(config.stateDir, { recursive: true });
          yield* fs.writeFileString(
            `${environmentSettingPath}.tmp`,
            yield* encodeEnvironmentSetting({ enabled }),
          );
          yield* fs.rename(`${environmentSettingPath}.tmp`, environmentSettingPath);
        }).pipe(Effect.tapCause(() => (previous ? startEnvironment(true) : stopEnvironment())));
      }, lock.withPermit);

      const moveLocalEnvironment = Effect.fn("HubHost.moveLocalEnvironment")(function* (
        input: HubEnvironmentMoveInput,
      ) {
        const next = yield* normalize(input);
        if (options.mode !== "serve") throw new Error("This installation has no environment.");
        if (environmentLink) yield* environmentLink.select({ ...input, ...next }, true);
        else {
          if (next.hubUrl !== null)
            throw new Error("Start the environment before moving it to a remote hub.");
          yield* saveEnvironmentConnection(config.stateDir, next);
          environmentConnection = next;
        }
      }, lock.withPermit);

      connection = yield* normalize(connection);
      listener.setRemoteHub(connection.hubUrl);
      const startupCredential = yield* auth.startup();
      const clientOrigin =
        config.publicUrl?.origin ??
        config.devUrl?.origin ??
        `http://${config.host ?? "127.0.0.1"}:${listener.port}`;
      const pairingUrl = `${clientOrigin}/pair#token=${encodeURIComponent(startupCredential)}&local=1`;
      yield* fs.makeDirectory(path.join(config.stateDir, "hub"), { recursive: true });
      yield* fs.writeFileString(
        path.join(config.stateDir, "hub", "listener.json"),
        yield* encodeListener({ origin: clientOrigin, port: listener.port }),
      );
      yield* Effect.logInfo(`pairingUrl: ${pairingUrl}`);
      yield* lock.withPermit(initiallyEnabled ? startEnvironment(false) : Effect.void);
      yield* Deferred.succeed(initialized, undefined);
      yield* Effect.logInfo(
        `T3 Code: http://${config.host ?? "127.0.0.1"}:${listener.port}${environmentScope ? "" : " (no environment)"}`,
      );
      return yield* Effect.never;
    },
    (effect, config) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provide(
          Layer.mergeAll(HubAuth.layer(config), OneChat.layer(config)).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(FileSystem.FileSystem, fs),
                Layer.succeed(Path.Path, path),
                Layer.succeed(Crypto.Crypto, crypto),
              ),
            ),
          ),
        ),
      ),
    Effect.mapError((cause) => new HubServer.HubTransportError({ cause })),
  );
  return HubHost.of({ run });
});

export const layer = Layer.effect(HubHost, make).pipe(
  Layer.provide(HubServer.layer),
  Layer.provide(FetchHttpClient.layer),
);
