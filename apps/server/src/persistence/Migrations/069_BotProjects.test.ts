import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "marks existing memory projects and their source events without hiding ordinary projects",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      for (const id of ["memory", "ordinary"]) {
        yield* sql`INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES (${id}, ${id}, ${`/workspace/${id}`}, '[]', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z')`;
        yield* sql`INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (${id}, 'project', ${id}, 1, 'project.created', '2026-10-20T00:00:00Z',
        'system', ${JSON.stringify({ projectId: id })}, '{}', 2)`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES ('memory-thread', 'memory', 'Memory', 'codex', 'full-access', 'default',
      '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '{}')`;
      yield* sql`INSERT INTO sats_bots (
      id, name, owner_environment_id, thread_id, state_json
    ) VALUES ('personal', 'Memory', 'local', 'memory-thread', '{}')`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT project_id, is_bot FROM projection_projects ORDER BY project_id`,
        [
          { project_id: "memory", is_bot: 1 },
          { project_id: "ordinary", is_bot: 0 },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT stream_id, json_extract(payload_json, '$.isBot') AS is_bot
        FROM orchestration_events WHERE event_type = 'project.created' ORDER BY stream_id`,
        [
          { stream_id: "memory", is_bot: 1 },
          { stream_id: "ordinary", is_bot: null },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
