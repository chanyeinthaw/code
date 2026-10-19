import MemoryChat from "./068_MemoryChat.ts";
import MemoryProjects from "./069_MemoryProjects.ts";
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
      yield* sql`INSERT INTO sats_memories (
      id, name, owner_environment_id, thread_id, state_json
    ) VALUES ('personal', 'Memory', 'local', 'memory-thread', '{}')`;
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT project_id, is_memory FROM projection_projects ORDER BY project_id`,
        [
          { project_id: "memory", is_memory: 1 },
          { project_id: "ordinary", is_memory: 0 },
        ],
      );
      assert.deepEqual(
        yield* sql`SELECT stream_id, json_extract(payload_json, '$.isMemory') AS is_memory
        FROM orchestration_events WHERE event_type = 'project.created' ORDER BY stream_id`,
        [
          { stream_id: "memory", is_memory: 1 },
          { stream_id: "ordinary", is_memory: null },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([65, 66])(
  "upgrades sats memory history through %s without losing memories",
  (lastId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* MemoryChat;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (65, 'MemoryChat')`;
      yield* sql`INSERT INTO sats_memories (id, name, owner_environment_id, thread_id, state_json)
      VALUES ('personal', 'Personal', 'owner', 'memory-thread', '{"retained":true}')`;
      if (lastId === 66) {
        yield* MemoryProjects;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (66, 'MemoryProjects')`;
      }
      yield* runMigrations();
      assert.deepEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 65 ORDER BY migration_id`,
        [
          { migration_id: 65, name: "CodexUsageNativeTurnIndex" },
          { migration_id: 66, name: "RepairClientSettlementTimestamps" },
          { migration_id: 67, name: "WebhookDedupe" },
          { migration_id: 68, name: "MemoryChat" },
          { migration_id: 69, name: "MemoryProjects" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT id, state_json FROM sats_memories`, [
        { id: "personal", state_json: '{"retained":true}' },
      ]);
      assert.deepEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
