import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Endpoint and header values live in the secret store; only the origin and header names are kept here.
  yield* sql`CREATE TABLE outgoing_webhooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    enabled_since TEXT,
    events_json TEXT NOT NULL,
    template TEXT NOT NULL,
    preview_length INTEGER NOT NULL,
    client_base_url TEXT,
    endpoint_origin TEXT NOT NULL,
    header_names_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  // The row is the delivery's idempotency identity; context_json is cleared once the job is finished.
  yield* sql`CREATE TABLE outgoing_webhook_jobs (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
    dedupe_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    thread_id TEXT,
    context_json TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    http_status INTEGER,
    failure TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (webhook_id, dedupe_key)
  )`;
  yield* sql`CREATE INDEX idx_outgoing_webhook_jobs_due
    ON outgoing_webhook_jobs(next_attempt_at) WHERE status = 'queued'`;
  yield* sql`CREATE INDEX idx_outgoing_webhook_jobs_history
    ON outgoing_webhook_jobs(webhook_id, created_at DESC)`;
});
