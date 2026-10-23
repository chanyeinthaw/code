/**
 * Webhook configuration and the delivery queue share one SQLite database with
 * the orchestration events, so a job can be enqueued in the same transaction
 * as the event that triggered it. Header values and secret endpoint URLs are
 * not here; they live in the server secret store.
 */
import {
  OutgoingWebhookDeliveryEventType,
  OutgoingWebhookEventType,
  OutgoingWebhookFailureCategory,
  OutgoingWebhookId,
  ThreadId,
  type OutgoingWebhookDelivery,
} from "@satslab/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How long a finished job stays as the record that its alert was sent. The
 * delivery history only shows the newest few, but every job in the window keeps
 * its (webhook, source) key, so a thread re-evaluated later cannot alert twice.
 * An alert that happened before the window is not news, since its key may be gone.
 */
export const OUTGOING_WEBHOOK_ALERT_WINDOW = Duration.days(14);

export interface StoredOutgoingWebhook {
  readonly id: OutgoingWebhookId;
  readonly name: string;
  readonly enabled: boolean;
  /** Set when the webhook is switched on, so completions from before that never fire it. */
  readonly enabledSince: string | null;
  readonly events: ReadonlyArray<OutgoingWebhookEventType>;
  readonly template: string;
  readonly previewLength: number;
  readonly clientBaseUrl: string | null;
  readonly endpointOrigin: string;
  /** The endpoint as ordinary configuration, or null when it is a secret in the secret store. */
  readonly endpointUrl: string | null;
  readonly headerNames: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Captured when the event commits, so every retry renders the same body even
 * if the webhook is edited in between. Endpoint and header values are not
 * part of it; the worker reads them from the current configuration and secret store.
 */
export const OutgoingWebhookJobContext = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  preview: Schema.String,
  template: Schema.String,
  clientBaseUrl: Schema.NullOr(Schema.String),
});
export type OutgoingWebhookJobContext = typeof OutgoingWebhookJobContext.Type;

export interface NewOutgoingWebhookJob {
  /** Also sent as the Idempotency-Key, so a retry after a lost response is recognisable. */
  readonly id: string;
  readonly webhookId: OutgoingWebhookId;
  /** Source identity of the event; one job per webhook for each. */
  readonly dedupeKey: string;
  readonly eventType: OutgoingWebhookDeliveryEventType;
  readonly context: OutgoingWebhookJobContext;
  readonly nextAttemptAt: number;
  readonly now: string;
}

export interface ClaimedOutgoingWebhookJob {
  readonly id: string;
  readonly webhookId: OutgoingWebhookId;
  readonly eventType: OutgoingWebhookDeliveryEventType;
  readonly context: OutgoingWebhookJobContext | null;
  readonly attempts: number;
}

interface WebhookRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: number;
  readonly enabled_since: string | null;
  readonly events_json: string;
  readonly template: string;
  readonly preview_length: number;
  readonly client_base_url: string | null;
  readonly endpoint_origin: string;
  readonly endpoint_url: string | null;
  readonly header_names_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface JobRow {
  readonly id: string;
  readonly webhook_id: string;
  readonly event_type: string;
  readonly thread_id: string | null;
  readonly context_json: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly http_status: number | null;
  readonly failure: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const EventsJson = Schema.fromJsonString(Schema.Array(OutgoingWebhookEventType));
const HeaderNamesJson = Schema.fromJsonString(Schema.Array(Schema.String));
const ContextJson = Schema.fromJsonString(OutgoingWebhookJobContext);
const decodeEvents = Schema.decodeUnknownSync(EventsJson);
const decodeHeaderNames = Schema.decodeUnknownSync(HeaderNamesJson);
const decodeContext = Schema.decodeUnknownSync(ContextJson);
const encodeEvents = Schema.encodeSync(EventsJson);
const encodeHeaderNames = Schema.encodeSync(HeaderNamesJson);
const encodeContext = Schema.encodeSync(ContextJson);
const decodeEventType = Schema.decodeUnknownSync(OutgoingWebhookDeliveryEventType);
const decodeWebhookId = Schema.decodeUnknownSync(OutgoingWebhookId);
const decodeFailure = Schema.decodeUnknownOption(OutgoingWebhookFailureCategory);

const toWebhook = (row: WebhookRow): StoredOutgoingWebhook => ({
  id: decodeWebhookId(row.id),
  name: row.name,
  enabled: row.enabled === 1,
  enabledSince: row.enabled_since,
  events: decodeEvents(row.events_json),
  template: row.template,
  previewLength: row.preview_length,
  clientBaseUrl: row.client_base_url,
  endpointOrigin: row.endpoint_origin,
  endpointUrl: row.endpoint_url,
  headerNames: decodeHeaderNames(row.header_names_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const DELIVERY_STATUSES: ReadonlyArray<OutgoingWebhookDelivery["status"]> = [
  "queued",
  "sending",
  "succeeded",
  "failed",
  "cancelled",
];

const toDelivery = (row: JobRow): OutgoingWebhookDelivery => ({
  id: row.id,
  webhookId: decodeWebhookId(row.webhook_id),
  eventType: decodeEventType(row.event_type),
  threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
  status: DELIVERY_STATUSES.find((status) => status === row.status) ?? "failed",
  attempts: row.attempts,
  httpStatus: row.http_status,
  failure: Option.getOrNull(decodeFailure(row.failure)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Plain functions over a SqlClient. EventSink builds one from its own client
 * so that enqueueing joins the event's transaction.
 */
export const makeOutgoingWebhookRepository = (sql: SqlClient.SqlClient) => {
  const list = Effect.fn("OutgoingWebhookRepository.list")(function* () {
    const rows = yield* sql<WebhookRow>`SELECT * FROM outgoing_webhooks ORDER BY created_at, id`;
    return rows.map(toWebhook);
  });

  const get = Effect.fn("OutgoingWebhookRepository.get")(function* (id: OutgoingWebhookId) {
    const rows = yield* sql<WebhookRow>`SELECT * FROM outgoing_webhooks WHERE id = ${id}`;
    return rows[0] === undefined ? null : toWebhook(rows[0]);
  });

  const enabled = Effect.fn("OutgoingWebhookRepository.enabled")(function* () {
    const rows = yield* sql<WebhookRow>`SELECT * FROM outgoing_webhooks WHERE enabled = 1`;
    return rows.map(toWebhook);
  });

  const save = Effect.fn("OutgoingWebhookRepository.save")(function* (
    webhook: StoredOutgoingWebhook,
  ) {
    yield* sql`
      INSERT INTO outgoing_webhooks (
        id, name, enabled, enabled_since, events_json, template, preview_length,
        client_base_url, endpoint_origin, endpoint_url, header_names_json, created_at, updated_at
      ) VALUES (
        ${webhook.id}, ${webhook.name}, ${webhook.enabled ? 1 : 0}, ${webhook.enabledSince},
        ${encodeEvents(webhook.events)}, ${webhook.template}, ${webhook.previewLength},
        ${webhook.clientBaseUrl}, ${webhook.endpointOrigin}, ${webhook.endpointUrl}, ${encodeHeaderNames(webhook.headerNames)},
        ${webhook.createdAt}, ${webhook.updatedAt}
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        enabled_since = excluded.enabled_since,
        events_json = excluded.events_json,
        template = excluded.template,
        preview_length = excluded.preview_length,
        client_base_url = excluded.client_base_url,
        endpoint_origin = excluded.endpoint_origin,
        endpoint_url = excluded.endpoint_url,
        header_names_json = excluded.header_names_json,
        updated_at = excluded.updated_at
    `;
  });

  /** Jobs go with the row (ON DELETE CASCADE). */
  const remove = Effect.fn("OutgoingWebhookRepository.remove")(function* (id: OutgoingWebhookId) {
    const rows = yield* sql<{ readonly id: string }>`
      DELETE FROM outgoing_webhooks WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  });

  /** A send already in flight cannot be recalled, but its outcome is not recorded over this. */
  const cancelPending = Effect.fn("OutgoingWebhookRepository.cancelPending")(function* (
    webhookId: OutgoingWebhookId,
    now: string,
  ) {
    yield* sql`
      UPDATE outgoing_webhook_jobs
      SET status = 'cancelled', context_json = NULL, updated_at = ${now}
      WHERE webhook_id = ${webhookId} AND status IN ('queued', 'sending')
    `;
  });

  /** The Test action's single attempt: recorded as already sending, so the queue never retries it. */
  const insertSending = Effect.fn("OutgoingWebhookRepository.insertSending")(function* (
    job: Omit<NewOutgoingWebhookJob, "dedupeKey" | "nextAttemptAt">,
  ) {
    yield* sql`
      INSERT INTO outgoing_webhook_jobs (
        id, webhook_id, dedupe_key, event_type, thread_id, context_json, status,
        attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${job.id}, ${job.webhookId}, ${job.id}, ${job.eventType}, ${job.context.threadId},
        ${encodeContext(job.context)}, 'sending', 1, 0, ${job.now}, ${job.now}
      )
    `;
  });

  /** Returns how many jobs were new; a repeated source identity inserts nothing. */
  const enqueue = Effect.fn("OutgoingWebhookRepository.enqueue")(function* (
    jobs: ReadonlyArray<NewOutgoingWebhookJob>,
  ) {
    let inserted = 0;
    for (const job of jobs) {
      const rows = yield* sql<{ readonly id: string }>`
        INSERT INTO outgoing_webhook_jobs (
          id, webhook_id, dedupe_key, event_type, thread_id, context_json, status,
          attempts, next_attempt_at, created_at, updated_at
        ) VALUES (
          ${job.id}, ${job.webhookId}, ${job.dedupeKey}, ${job.eventType}, ${job.context.threadId},
          ${encodeContext(job.context)}, 'queued', 0, ${job.nextAttemptAt}, ${job.now}, ${job.now}
        )
        ON CONFLICT(webhook_id, dedupe_key) DO NOTHING
        RETURNING id
      `;
      inserted += rows.length;
    }
    return inserted;
  });

  /** At startup, a job a previous process left mid-send goes back to the queue; delivery is at-least-once. */
  const requeueInterrupted = Effect.fn("OutgoingWebhookRepository.requeueInterrupted")(function* (
    now: string,
  ) {
    yield* sql`
      UPDATE outgoing_webhook_jobs SET status = 'queued', updated_at = ${now}
      WHERE status = 'sending'
    `;
  });

  const claimDue = Effect.fn("OutgoingWebhookRepository.claimDue")(function* (input: {
    readonly nowMs: number;
    readonly now: string;
    readonly limit: number;
  }) {
    const rows = yield* sql<JobRow>`
      UPDATE outgoing_webhook_jobs
      SET status = 'sending', attempts = attempts + 1, updated_at = ${input.now}
      WHERE id IN (
        SELECT id FROM outgoing_webhook_jobs
        WHERE status = 'queued' AND next_attempt_at <= ${input.nowMs}
        ORDER BY next_attempt_at, created_at
        LIMIT ${input.limit}
      )
      RETURNING *
    `;
    return rows.map((row): ClaimedOutgoingWebhookJob => ({
      id: row.id,
      webhookId: decodeWebhookId(row.webhook_id),
      eventType: decodeEventType(row.event_type),
      context: row.context_json === null ? null : decodeContext(row.context_json),
      attempts: row.attempts,
    }));
  });

  const nextDueAt = Effect.fn("OutgoingWebhookRepository.nextDueAt")(function* () {
    const rows = yield* sql<{ readonly next: number | null }>`
      SELECT MIN(next_attempt_at) AS next FROM outgoing_webhook_jobs WHERE status = 'queued'
    `;
    return rows[0]?.next ?? null;
  });

  const retryLater = Effect.fn("OutgoingWebhookRepository.retryLater")(function* (input: {
    readonly id: string;
    readonly nextAttemptAt: number;
    readonly httpStatus: number | null;
    readonly failure: OutgoingWebhookFailureCategory;
    readonly now: string;
  }) {
    yield* sql`
      UPDATE outgoing_webhook_jobs
      SET status = 'queued', next_attempt_at = ${input.nextAttemptAt},
        http_status = ${input.httpStatus}, failure = ${input.failure}, updated_at = ${input.now}
      WHERE id = ${input.id} AND status = 'sending'
    `;
  });

  /** Drops the captured context: a finished job keeps only its status, never the payload. */
  const finish = Effect.fn("OutgoingWebhookRepository.finish")(function* (input: {
    readonly id: string;
    readonly webhookId: OutgoingWebhookId;
    readonly status: "succeeded" | "failed";
    readonly httpStatus: number | null;
    readonly failure: OutgoingWebhookFailureCategory | null;
    readonly now: string;
  }) {
    yield* sql`
      UPDATE outgoing_webhook_jobs
      SET status = ${input.status}, context_json = NULL, http_status = ${input.httpStatus},
        failure = ${input.failure}, updated_at = ${input.now}
      WHERE id = ${input.id} AND status = 'sending'
    `;
    const keepSince = DateTime.formatIso(
      DateTime.subtract(DateTime.makeUnsafe(input.now), {
        milliseconds: Duration.toMillis(OUTGOING_WEBHOOK_ALERT_WINDOW),
      }),
    );
    yield* sql`
      DELETE FROM outgoing_webhook_jobs
      WHERE webhook_id = ${input.webhookId}
        AND status IN ('succeeded', 'failed', 'cancelled')
        AND created_at < ${keepSince}
    `;
  });

  const history = Effect.fn("OutgoingWebhookRepository.history")(function* (
    webhookId: OutgoingWebhookId,
    limit: number,
  ) {
    const rows = yield* sql<JobRow>`
      SELECT * FROM outgoing_webhook_jobs
      WHERE webhook_id = ${webhookId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map(toDelivery);
  });

  const job = Effect.fn("OutgoingWebhookRepository.job")(function* (id: string) {
    const rows = yield* sql<JobRow>`SELECT * FROM outgoing_webhook_jobs WHERE id = ${id}`;
    return rows[0] === undefined ? null : toDelivery(rows[0]);
  });

  return {
    list,
    get,
    enabled,
    save,
    remove,
    cancelPending,
    enqueue,
    insertSending,
    requeueInterrupted,
    claimDue,
    nextDueAt,
    retryLater,
    finish,
    history,
    job,
  };
};

export class OutgoingWebhookRepository extends Context.Service<
  OutgoingWebhookRepository,
  ReturnType<typeof makeOutgoingWebhookRepository>
>()("@satslab/sora/outgoingWebhooks/OutgoingWebhookRepository") {}

export const layer = Layer.effect(
  OutgoingWebhookRepository,
  Effect.map(SqlClient.SqlClient, (sql) =>
    OutgoingWebhookRepository.of(makeOutgoingWebhookRepository(sql)),
  ),
);
