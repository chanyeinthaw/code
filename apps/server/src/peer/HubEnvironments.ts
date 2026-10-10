import {
  EnvironmentId,
  HubEnvironmentCatalog,
  OrchestratorMcpFailure,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";

export interface HubEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: "reachable" | "unreachable";
  readonly access: AuthMcpClientAccess;
  readonly lastError: string | null;
}
export interface ResolvedHubEnvironment {
  readonly link: HubEnvironment;
  readonly url: string;
  readonly token: string;
}

/** Automatically discovers destinations through this environment's enrolled hub tunnel. */
export class HubEnvironments extends Context.Service<
  HubEnvironments,
  {
    readonly list: Effect.Effect<ReadonlyArray<HubEnvironment>, OrchestratorMcpFailure>;
    readonly get: (
      id: EnvironmentId,
    ) => Effect.Effect<Option.Option<HubEnvironment>, OrchestratorMcpFailure>;
    readonly resolve: (
      id: EnvironmentId,
    ) => Effect.Effect<ResolvedHubEnvironment, OrchestratorMcpFailure>;
    readonly recordOutcome: (
      id: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
  }
>()("t3/peer/HubEnvironments") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const http = yield* HttpClient.HttpClient;
  const gateway =
    config.hubOrchestrationPort === undefined
      ? undefined
      : `http://127.0.0.1:${config.hubOrchestrationPort}`;
  const list = Effect.fn("HubEnvironments.list")(function* () {
    if (gateway === undefined || config.hubIngressSecret === undefined) return [];
    const catalog = yield* http
      .get(`${gateway}/hub/environments`, {
        headers: { authorization: `Bearer ${config.hubIngressSecret}` },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(HubEnvironmentCatalog)),
        Effect.timeout("10 seconds"),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The hub is unavailable.",
            }),
        ),
      );
    return catalog.environments.map((environment): HubEnvironment => ({
      environmentId: environment.environmentId,
      label: environment.label,
      status: environment.connected ? "reachable" : "unreachable",
      access: "full-access",
      lastError: environment.connected ? null : "Environment unavailable",
    }));
  });
  const get = Effect.fn("HubEnvironments.get")(function* (id: EnvironmentId) {
    return Option.fromNullishOr(
      (yield* list()).find((environment) => environment.environmentId === id),
    );
  });
  const resolve = Effect.fn("HubEnvironments.resolve")(function* (id: EnvironmentId) {
    const found = yield* get(id);
    if (Option.isNone(found) || gateway === undefined || config.hubIngressSecret === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "This environment is not enrolled in the connected hub.",
      });
    if (found.value.status !== "reachable")
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Environment unavailable",
      });
    return {
      link: found.value,
      url: `${gateway}/hub/environments/${encodeURIComponent(id)}`,
      token: config.hubIngressSecret,
    };
  });
  return HubEnvironments.of({ list: list(), get, resolve, recordOutcome: () => Effect.void });
});
export const layer = Layer.effect(HubEnvironments, make);
