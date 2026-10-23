import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OutgoingWebhookUpsertInput,
  SecretRequestError,
} from "@satslab/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Delivery from "./OutgoingWebhookDelivery.ts";
import * as Repository from "./OutgoingWebhookRepository.ts";
import * as Service from "./OutgoingWebhookService.ts";

/** What the fake destination does with request number n (1-based): a status, or a transport failure. */
export type DestinationScript = (attempt: number) => number | "network-error";

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const SECRET_URL = "https://hooks.example.test/in/very-secret-token-123";

/**
 * A real in-memory database, event sink, projections and delivery queue, with
 * only the outside world faked: the destination, the secret store, secret refs.
 */
export const makeHarness = (options?: {
  readonly script?: DestinationScript;
  /** The destination holds every response until this completes. */
  readonly gate?: Deferred.Deferred<void>;
  /** A real client, for tests that talk to a local fixture server. */
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
}) => {
  const script: DestinationScript = options?.script ?? (() => 200);
  const requestStarted = Deferred.makeUnsafe<void>();
  const requests: Array<RecordedRequest> = [];
  const store = new Map<string, Uint8Array>();
  const refs = new Map<string, string>();
  let issuedRefs = 0;

  const layerDatabase = SqlitePersistence.layerMemory;
  const layerEventStore = EventStore.layer.pipe(Layer.provideMerge(layerDatabase));
  const layerProjections = ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase));
  const layerStores = Layer.mergeAll(layerDatabase, layerEventStore, layerProjections);
  const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));

  const layerSecretStore = Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
      set: (name, value) => Effect.sync(() => void store.set(name, value)),
      create: (name, value) => Effect.sync(() => void store.set(name, value)),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
      remove: (name) => Effect.sync(() => void store.delete(name)),
    }),
  );
  const layerSecretRequests = Layer.succeed(
    SecretRequests.SecretRequests,
    SecretRequests.SecretRequests.of({
      answer: () => Effect.void,
      savedRef: () => Effect.succeed(Option.none()),
      // One use, as the real store: the value is gone after it is redeemed.
      consume: ({ ref }) => {
        const value = refs.get(ref);
        refs.delete(ref);
        return value === undefined
          ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
          : Effect.succeed(value);
      },
    }),
  );
  const layerEnvironment = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("env-test"),
      label: "Test",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: false },
    }),
  });
  const layerFakeHttp = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        requests.push({ url: request.url, headers: { ...request.headers }, body: text });
        const result = script(requests.length);
        const respond =
          result === "network-error"
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              )
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("echo " + SECRET_URL, { status: result }),
                ),
              );
        return Deferred.succeed(requestStarted, undefined).pipe(
          Effect.andThen(options?.gate === undefined ? Effect.void : Deferred.await(options.gate)),
          Effect.andThen(respond),
        );
      }),
    ),
  );

  const layerHttp = options?.http ?? layerFakeHttp;
  const layerRepository = Repository.layer.pipe(Layer.provide(layerDatabase));
  const layerDelivery = Delivery.layer.pipe(
    Layer.provide(Layer.mergeAll(layerRepository, layerSecretStore, layerEnvironment, layerHttp)),
  );
  const layerService = Service.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRepository,
        layerSecretStore,
        layerSecretRequests,
        layerDelivery,
        NodeCrypto.layer,
      ),
    ),
  );
  const layer = Layer.mergeAll(
    layerStores,
    layerEventSink,
    layerRepository,
    layerDelivery,
    layerService,
    layerSecretStore,
  );

  return {
    layer,
    requests,
    requestStarted,
    secretNames: () => [...store.keys()],
    /** Stands in for the user answering request_secret. */
    issueSecretRef: (value: string) => {
      issuedRefs += 1;
      const ref = `secret-ref:${issuedRefs.toString(16).padStart(32, "0")}`;
      refs.set(ref, value);
      return ref;
    },
  };
};

export const webhookInput = (
  overrides: Partial<OutgoingWebhookUpsertInput> = {},
): OutgoingWebhookUpsertInput => ({
  name: "Hark",
  enabled: true,
  events: ["completed", "failed", "approval_required", "input_required"],
  template: '{"title":"{{thread.title}}","body":"{{message.preview}}","url":"{{thread.url}}"}',
  previewLength: 500,
  clientBaseUrl: "https://sora.example.test",
  endpoint: { value: SECRET_URL },
  // Most tests are about what stays private; a test for ordinary configuration overrides this.
  secretEndpoint: true,
  headers: [{ name: "Authorization", value: { value: "Bearer header-secret-456" } }],
  ...overrides,
});

const providerInstanceId = ProviderInstanceId.make("codex");

export const makeThread = (
  id: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const now = DateTime.makeUnsafe("2100-01-01T00:00:00Z");
  const threadId = ThreadId.make(id);
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:webhooks"),
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

// Far in the future so runs finish after a webhook enabled on the real clock; the earlier-completion test moves past it.
const occurredAt = DateTime.makeUnsafe("2100-01-01T00:05:00Z");

export const threadCreated = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${thread.id}:created`),
  type: "thread.created",
  threadId: thread.id,
  occurredAt: thread.createdAt,
  payload: thread,
});

export const runUpdated = (
  threadId: ThreadId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  /** Distinguishes a repeated update; event ids are unique. */
  repeat = 0,
  /** When the run finished; the default is far ahead of any test clock. */
  at: DateTime.Utc = occurredAt,
): OrchestrationV2DomainEvent => {
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  const terminal = status === "completed" || status === "failed";
  return {
    id: EventId.make(`event:${runId}:${status}:${repeat}`),
    type: "run.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test-model" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}:user`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: terminal ? at : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
};

export const assistantMessage = (threadId: ThreadId, text: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${threadId}:assistant:${text.length}`),
  type: "message.updated",
  threadId,
  occurredAt,
  payload: {
    createdBy: "agent",
    creationSource: "provider",
    id: MessageId.make(`message:${threadId}:assistant:${text.length}`),
    threadId,
    runId: RunId.make(`run:${threadId}:1`),
    nodeId: null,
    role: "assistant",
    text,
    attachments: [],
    streaming: false,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  },
});

export const runtimeRequest = (
  threadId: ThreadId,
  id: string,
  kind: "command" | "user_input",
  status: "pending" | "resolved",
  repeat = 0,
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${id}:${status}:${repeat}`),
  type: "runtime-request.updated",
  threadId,
  occurredAt,
  payload: {
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make(`node:${id}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind,
    status,
    responseCapability: { type: "not_resumable", reason: "test" },
    createdAt: occurredAt,
    resolvedAt: status === "resolved" ? occurredAt : null,
  },
});
