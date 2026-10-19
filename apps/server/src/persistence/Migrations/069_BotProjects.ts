import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE projection_projects SET is_bot = 1 WHERE project_id IN (
    SELECT project_id FROM orchestration_v2_projection_threads
    WHERE thread_id IN (SELECT thread_id FROM sats_bots)
  )`;
  // Preserve the flag when project projections are rebuilt from their source events.
  yield* sql`UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.isBot', json('true'))
    WHERE application_event_version = 2 AND aggregate_kind = 'project'
      AND event_type = 'project.created'
      AND stream_id IN (SELECT project_id FROM projection_projects WHERE is_bot = 1)`;
});
