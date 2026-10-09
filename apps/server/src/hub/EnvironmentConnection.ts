import {
  HubConnection,
  type HubEnvironmentMoveInput,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse, HttpBody } from "effect/http";
import { connectEnvironment } from "./EnvironmentTunnel.ts";
import { HubTransportError } from "./HubServer.ts";

const credentialsSchema = Schema.Record(Schema.String, Schema.String);
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(credentialsSchema));
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(credentialsSchema));
const decodeConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(HubConnection));
const encodeConnection = Schema.encodeEffect(Schema.fromJsonString(HubConnection));

/** A saved environment target overrides CLI flags and the client's selected hub. */
export const readEnvironmentConnection = Effect.fn("EnvironmentConnection.read")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${stateDir}/hub-environment-connection.json`;
  return (yield* fs.exists(file))
    ? yield* decodeConnection(yield* fs.readFileString(file))
    : undefined;
});

export const saveEnvironmentConnection = Effect.fn("EnvironmentConnection.save")(function* (
  stateDir: string,
  connection: HubConnection,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${stateDir}/hub-environment-connection.json`;
  yield* fs.writeFileString(`${file}.tmp`, yield* encodeConnection(connection));
  yield* fs.rename(`${file}.tmp`, file);
});

/** Own the outbound link separately from execution, so transfers never restart agents. */
export const openEnvironmentConnection = Effect.fn("EnvironmentConnection.open")(
  function* (options: {
    readonly stateDir: string;
    readonly initial: HubConnection;
    readonly ownedHub?: string;
    readonly localPort: number;
    readonly descriptor: ExecutionEnvironmentDescriptor;
    readonly ingressSecret: string;
    readonly enrollOwned?: () => Effect.Effect<string, HubTransportError>;
    readonly onSelected: (connection: HubConnection, persisted: boolean) => void;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const client = yield* HttpClient.HttpClient;
    const scope = yield* Effect.scope;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const lock = yield* Semaphore.make(1);
    const credentialsPath = `${options.stateDir}/hub-daemon-credentials.json`;
    let credentials: Record<string, string> = (yield* fs.exists(credentialsPath))
      ? yield* decodeCredentials(yield* fs.readFileString(credentialsPath))
      : {};
    let current = options.initial;
    let tunnel: Fiber.Fiber<void, HubTransportError> | undefined;

    const normalize = (input: HubConnection) =>
      Effect.try({
        try: () => {
          if (input.hubUrl === null) {
            if (!options.ownedHub) throw new Error("This environment has no owned hub.");
            return input;
          }
          const url = new URL(input.hubUrl);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== "/" ||
            url.search ||
            url.hash
          )
            throw new Error("Use an HTTP or HTTPS hub origin.");
          if (options.ownedHub && url.origin === new URL(options.ownedHub).origin)
            return { hubUrl: null };
          return { hubUrl: url.origin };
        },
        catch: (cause) => new HubTransportError({ cause }),
      });
    const enroll = Effect.fn("EnvironmentConnection.enroll")(function* (
      input: HubEnvironmentMoveInput,
    ) {
      const key = input.hubUrl ?? "local";
      if (input.hubUrl === null && options.enrollOwned) {
        credentials[key] = yield* options.enrollOwned();
      } else if (input.environmentInvitation) {
        const enrolled = yield* client
          .post(`${input.hubUrl}/hub/auth/enroll`, {
            body: HttpBody.jsonUnsafe({
              credential: input.environmentInvitation,
              ...options.descriptor,
            }),
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(Schema.Struct({ credential: Schema.String })),
            ),
            Effect.timeout("5 seconds"),
          );
        credentials[key] = enrolled.credential;
      }
      if (!credentials[key])
        return yield* new HubTransportError({ cause: "An environment invitation is required." });
      yield* fs.writeFileString(`${credentialsPath}.tmp`, yield* encodeCredentials(credentials));
      yield* fs.chmod(`${credentialsPath}.tmp`, 0o600);
      yield* fs.rename(`${credentialsPath}.tmp`, credentialsPath);
    });
    let handleMove: (
      source: HubConnection,
      input: HubEnvironmentMoveInput,
      acknowledge: () => Promise<void>,
    ) => Promise<void>;
    const launch = Effect.fn("EnvironmentConnection.launch")(function* (next: HubConnection) {
      const ready = yield* Deferred.make<void>();
      const fiber = yield* connectEnvironment({
        hubUrl: next.hubUrl ?? options.ownedHub ?? "",
        localPort: options.localPort,
        environmentId: options.descriptor.environmentId,
        label: options.descriptor.label,
        credential: credentials[next.hubUrl ?? "local"],
        ingressSecret: options.ingressSecret,
        onRegistered: () => Effect.runSync(Deferred.succeed(ready, undefined)),
        // Run outside the source tunnel's fiber so replacing it cannot interrupt the transfer.
        onMove: (input, acknowledge) => handleMove(next, input, acknowledge),
      }).pipe(Effect.scoped, Effect.retry(Schedule.spaced("2 seconds")), Effect.forkIn(scope));
      return { fiber, ready };
    });
    const select = Effect.fn("EnvironmentConnection.select")(
      function* (
        input: HubEnvironmentMoveInput,
        persist: boolean,
        acknowledge?: () => Promise<void>,
        source?: HubConnection,
      ) {
        if (source && source.hubUrl !== current.hubUrl)
          return yield* new HubTransportError({
            cause: "The source hub no longer owns this connection.",
          });
        const next = yield* normalize(input);
        if (next.hubUrl === current.hubUrl && tunnel) {
          if (acknowledge)
            return yield* new HubTransportError({ cause: "Environment already uses this hub." });
          if (persist) yield* saveEnvironmentConnection(options.stateDir, next);
          options.onSelected(next, persist);
          return;
        }
        const previous = current;
        const previousCredential = credentials[previous.hubUrl ?? "local"];
        const previousSaved = persist
          ? yield* readEnvironmentConnection(options.stateDir)
          : undefined;
        let saved = false;
        let committed = false;
        yield* enroll({ ...input, ...next });
        const pending = yield* launch(next);
        yield* Effect.gen(function* () {
          yield* Deferred.await(pending.ready).pipe(Effect.timeout("15 seconds"));
          if (persist) {
            yield* saveEnvironmentConnection(options.stateDir, next);
            saved = true;
          }
          // Flush the source reply while its socket is alive, after the destination accepts us.
          if (acknowledge)
            yield* Effect.tryPromise({
              try: acknowledge,
              catch: (cause) => new HubTransportError({ cause }),
            });
          if (tunnel) yield* Fiber.interrupt(tunnel);
          tunnel = pending.fiber;
          current = next;
          options.onSelected(next, persist);
          committed = true;
          if (persist && previous.hubUrl !== next.hubUrl && previousCredential) {
            const previousHub = previous.hubUrl ?? options.ownedHub;
            const authPath = previous.hubUrl === null ? "local-auth" : "auth";
            yield* client
              .post(`${previousHub}/hub/${authPath}/leave`, {
                headers: { authorization: `Bearer ${previousCredential}` },
                body: HttpBody.jsonUnsafe({ environmentId: options.descriptor.environmentId }),
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.timeout("5 seconds"),
                Effect.catch(() =>
                  Effect.logWarning("Could not retire the previous hub enrollment."),
                ),
              );
          }
        }).pipe(
          Effect.tapCause(() =>
            Effect.gen(function* () {
              if (committed) return;
              yield* Fiber.interrupt(pending.fiber);
              if (saved) {
                if (previousSaved)
                  yield* saveEnvironmentConnection(options.stateDir, previousSaved);
                else yield* fs.remove(`${options.stateDir}/hub-environment-connection.json`);
              }
              yield* client
                .post(
                  `${next.hubUrl ?? options.ownedHub}/hub/${next.hubUrl === null ? "local-auth" : "auth"}/leave`,
                  {
                    headers: { authorization: `Bearer ${credentials[next.hubUrl ?? "local"]}` },
                    body: HttpBody.jsonUnsafe({ environmentId: options.descriptor.environmentId }),
                  },
                )
                .pipe(Effect.timeout("5 seconds"), Effect.ignore);
            }),
          ),
        );
      },
      lock.withPermit,
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError((cause) => new HubTransportError({ cause })),
    );

    handleMove = (source, input, acknowledge) =>
      runPromise(
        select(input, true, acknowledge, source).pipe(
          Effect.forkIn(scope),
          Effect.flatMap(Fiber.join),
        ),
      );

    const start = Effect.fn("EnvironmentConnection.start")(
      function* (waitForRegistration: boolean) {
        current = yield* normalize(current);
        yield* enroll(current);
        const pending = yield* launch(current);
        tunnel = pending.fiber;
        if (waitForRegistration)
          yield* Deferred.await(pending.ready).pipe(Effect.timeout("15 seconds"));
      },
      Effect.mapError((cause) => new HubTransportError({ cause })),
    );
    return {
      start,
      select,
      hasCredential: (connection: HubConnection) =>
        Boolean(credentials[connection.hubUrl ?? "local"]),
    };
  },
);
