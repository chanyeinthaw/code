/**
 * Sends queued webhook jobs. It runs on its own loop, never inside the
 * per-thread effect queue, so a slow or failing destination cannot hold up a
 * thread's next turn. Delivery is at-least-once: a retry after a lost response
 * carries the same Idempotency-Key, and the destination decides whether to
 * deduplicate. Failures are stored as a category, never as the raw error or
 * response body, since either can echo the credential-bearing URL.
 */
import { type OutgoingWebhookFailureCategory, type OutgoingWebhookId } from "@satslab/contracts";
import {
  buildOutgoingWebhookNativeThreadUrls,
  buildOutgoingWebhookThreadUrl,
  isValidOutgoingWebhookHeaderValue,
  outgoingWebhookBodyTooLarge,
  parseOutgoingWebhookEndpoint,
  parseOutgoingWebhookTemplate,
  renderOutgoingWebhookTemplate,
} from "@satslab/shared/outgoingWebhook";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  OutgoingWebhookRepository,
  type ClaimedOutgoingWebhookJob,
} from "./OutgoingWebhookRepository.ts";
import { endpointSecretName, headerSecretName } from "./OutgoingWebhookSecrets.ts";

const SEND_TIMEOUT = Duration.seconds(10);
const CLAIM_BATCH = 10;
const SEND_CONCURRENCY = 4;
/** Attempts per job; the last failure is final. */
export const MAX_OUTGOING_WEBHOOK_ATTEMPTS = 5;
const RETRY_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(10),
  Duration.minutes(1),
  Duration.minutes(5),
  Duration.minutes(15),
];

type Outcome =
  | { readonly kind: "sent"; readonly httpStatus: number }
  | {
      readonly kind: "failed";
      readonly failure: OutgoingWebhookFailureCategory;
      readonly httpStatus: number | null;
      /** Worth another attempt: the destination or network may recover. */
      readonly transient: boolean;
    };

interface Prepared {
  readonly kind: "ready";
  readonly endpoint: URL;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
}

const failed = (
  failure: OutgoingWebhookFailureCategory,
  transient: boolean,
  httpStatus: number | null = null,
): Outcome => ({ kind: "failed", failure, httpStatus, transient });

const classifyStatus = (status: number): Outcome => {
  if (status >= 200 && status < 300) return { kind: "sent", httpStatus: status };
  if (status === 429) return failed("rate_limited", true, status);
  if (status === 408 || status >= 500) return failed("server_error", true, status);
  return failed("rejected", false, status);
};

export class OutgoingWebhookDelivery extends Context.Service<
  OutgoingWebhookDelivery,
  {
    /** Delivers everything that is due now. The scheduler calls it; tests await it. */
    readonly drain: Effect.Effect<void>;
    /** One attempt for a job already claimed, with no retry scheduled. */
    readonly attemptOnce: (job: ClaimedOutgoingWebhookJob) => Effect.Effect<void>;
  }
>()("@satslab/sora/outgoingWebhooks/OutgoingWebhookDelivery") {}

const make = Effect.gen(function* () {
  const repository = yield* OutgoingWebhookRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const client = yield* HttpClient.HttpClient;

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  /** Everything up to the HTTP call; none of it needs the network. */
  const prepare = Effect.fn("OutgoingWebhookDelivery.prepare")(function* (
    job: ClaimedOutgoingWebhookJob,
  ) {
    const webhook = yield* repository.get(job.webhookId).pipe(Effect.orDie);
    // A claim can race the user turning the webhook off; only the Test action runs while disabled.
    if (webhook === null || (!webhook.enabled && job.eventType !== "test")) return null;
    if (job.context === null) return failed("template_invalid", false);
    const endpoint = Option.flatMap(
      webhook.endpointUrl === null
        ? yield* readSecret(endpointSecretName(webhook.id))
        : Option.some(webhook.endpointUrl),
      (value) => Option.fromNullishOr(parseOutgoingWebhookEndpoint(value)),
    );
    if (Option.isNone(endpoint)) return failed("secret_missing", false);
    const headers: Array<readonly [string, string]> = [];
    for (const name of webhook.headerNames) {
      const value = yield* readSecret(headerSecretName(webhook.id, name));
      if (Option.isNone(value) || !isValidOutgoingWebhookHeaderValue(value.value)) {
        return failed("secret_missing", false);
      }
      headers.push([name, value.value]);
    }
    // The queued snapshot, not the webhook's current settings: a retry must repeat the first body.
    const template = parseOutgoingWebhookTemplate(job.context.template);
    if (!template.ok) return failed("template_invalid", false);
    const descriptor = yield* environment.getDescriptor;
    const body = renderOutgoingWebhookTemplate(template, {
      thread: {
        id: job.context.threadId,
        title: job.context.threadTitle,
        url: buildOutgoingWebhookThreadUrl({
          clientBaseUrl: job.context.clientBaseUrl,
          environmentId: descriptor.environmentId,
          threadId: job.context.threadId,
        }),
        ...buildOutgoingWebhookNativeThreadUrls({
          environmentId: descriptor.environmentId,
          threadId: job.context.threadId,
        }),
      },
      message: { preview: job.context.preview },
      event: { type: job.eventType },
    });
    if (outgoingWebhookBodyTooLarge(body)) return failed("payload_too_large", false);
    return { kind: "ready", endpoint: endpoint.value, headers, body } satisfies Prepared;
  });

  const send = Effect.fn("OutgoingWebhookDelivery.send")(function* (
    job: ClaimedOutgoingWebhookJob,
    request: Prepared,
  ) {
    return yield* HttpClientRequest.post(request.endpoint).pipe(
      HttpClientRequest.setHeaders(Object.fromEntries(request.headers)),
      HttpClientRequest.setHeader("Idempotency-Key", job.id),
      HttpClientRequest.bodyText(request.body, "application/json"),
      client.execute,
      Effect.flatMap((response) =>
        // The body is not needed; taking one chunk lets the connection be released without reading a hostile response in full.
        response.stream.pipe(
          Stream.take(1),
          Stream.runDrain,
          Effect.ignore,
          Effect.as(classifyStatus(response.status)),
        ),
      ),
      Effect.timeout(SEND_TIMEOUT),
      // A redirect would resend the configured headers to wherever it points.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.catchTags({
        TimeoutError: () => Effect.succeed(failed("timeout", true)),
        HttpClientError: () => Effect.succeed(failed("network", true)),
      }),
    );
  });

  const nextDelay = (attempts: number) =>
    RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)] ?? Duration.minutes(15);

  const settle = Effect.fn("OutgoingWebhookDelivery.settle")(function* (
    job: ClaimedOutgoingWebhookJob,
    outcome: Outcome,
    retry: boolean,
  ) {
    const now = yield* DateTime.now;
    const iso = DateTime.formatIso(now);
    if (outcome.kind === "sent") {
      return yield* repository.finish({
        id: job.id,
        webhookId: job.webhookId,
        status: "succeeded",
        httpStatus: outcome.httpStatus,
        failure: null,
        now: iso,
      });
    }
    if (retry && outcome.transient && job.attempts < MAX_OUTGOING_WEBHOOK_ATTEMPTS) {
      return yield* repository.retryLater({
        id: job.id,
        nextAttemptAt: now.epochMilliseconds + Duration.toMillis(nextDelay(job.attempts)),
        httpStatus: outcome.httpStatus,
        failure: outcome.failure,
        now: iso,
      });
    }
    return yield* repository.finish({
      id: job.id,
      webhookId: job.webhookId,
      status: "failed",
      httpStatus: outcome.httpStatus,
      failure: outcome.failure,
      now: iso,
    });
  });

  const attempt = Effect.fn("OutgoingWebhookDelivery.attempt")(function* (
    job: ClaimedOutgoingWebhookJob,
    retry: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({
      "outgoing_webhook.id": job.webhookId satisfies OutgoingWebhookId,
      "outgoing_webhook.attempt": job.attempts,
    });
    const prepared = yield* prepare(job);
    // The webhook was deleted after the claim; its jobs went with it.
    if (prepared === null) return;
    const outcome = prepared.kind === "ready" ? yield* send(job, prepared) : prepared;
    yield* settle(job, outcome, retry);
  });

  const guarded = (job: ClaimedOutgoingWebhookJob, retry: boolean) =>
    attempt(job, retry).pipe(
      // A storage fault must not stop the worker; startup requeues a job left mid-send.
      Effect.catchCause((cause) =>
        Effect.logWarning("outgoing webhook attempt failed", {
          webhookId: job.webhookId,
          cause,
        }),
      ),
    );

  const drain = Effect.gen(function* () {
    while (true) {
      const now = yield* DateTime.now;
      const claimed = yield* repository.claimDue({
        nowMs: now.epochMilliseconds,
        now: DateTime.formatIso(now),
        limit: CLAIM_BATCH,
      });
      if (claimed.length === 0) return;
      yield* Effect.forEach(claimed, (job) => guarded(job, true), {
        concurrency: SEND_CONCURRENCY,
        discard: true,
      });
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("outgoing webhook pass failed", { cause })),
    Effect.withSpan("OutgoingWebhookDelivery.drain"),
  );

  const attemptOnce = Effect.fn("OutgoingWebhookDelivery.attemptOnce")(
    (job: ClaimedOutgoingWebhookJob) => guarded(job, false),
  );

  return OutgoingWebhookDelivery.of({ drain, attemptOnce });
});

export const layer = Layer.effect(OutgoingWebhookDelivery, make);

/**
 * Registers the queue with the shared scheduler, which ticks every few seconds
 * once the server is active. A job a previous process left mid-send goes back
 * to the queue first; delivery is at-least-once.
 */
export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const repository = yield* OutgoingWebhookRepository;
    const delivery = yield* OutgoingWebhookDelivery;
    const scheduler = yield* Scheduler.Scheduler;
    yield* repository
      .requeueInterrupted(DateTime.formatIso(yield* DateTime.now))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("outgoing webhook requeue failed", { cause }),
        ),
      );
    yield* scheduler.register("outgoing-webhooks", delivery.drain);
  }),
);
