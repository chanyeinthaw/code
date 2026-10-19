import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sats_bots (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', destination_environment_id TEXT,
    state_json TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0, transfer_id TEXT, release_secret TEXT, release_hash TEXT, transfer_json TEXT, transfer_imported INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE sats_bot_transfer_chunks (
    transfer_id TEXT NOT NULL, offset INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(transfer_id,offset)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE sats_bot_memory_messages (
    bot_id TEXT NOT NULL, id INTEGER NOT NULL, event_key TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL,
    PRIMARY KEY(bot_id,id), UNIQUE(bot_id,event_key)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE sats_bot_memory_nodes (
    bot_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(bot_id,count,id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE sats_bot_memory_jobs (
    bot_id TEXT NOT NULL, id INTEGER NOT NULL, count INTEGER NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    PRIMARY KEY(bot_id,count,id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX sats_bot_memory_jobs_ready ON sats_bot_memory_jobs(status,bot_id,count,id)`;
  yield* sql`CREATE TABLE sats_bot_memory_snapshots (
    bot_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, total INTEGER NOT NULL, view TEXT NOT NULL,
    PRIMARY KEY(bot_id,run_id)
  ) WITHOUT ROWID`;
});
