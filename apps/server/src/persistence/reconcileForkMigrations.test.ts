import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import BotChat from "./Migrations/069_BotChat.ts";
import BotProjects from "./Migrations/070_BotProjects.ts";

it.effect.each([68, 69])("upgrades shipped Sora migration history through %s", (lastId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    yield* Migrator.make({})({
      loader: Migrator.fromRecord({
        "68_BotChat": BotChat,
        ...(lastId >= 69 ? { "69_BotProjects": BotProjects } : {}),
      }),
    });
    yield* sql`INSERT INTO sats_bots (id, name, owner_environment_id, thread_id, state_json)
      VALUES ('personal', 'Memory', 'local', 'memory-thread', '{}')`;
    yield* sql`INSERT INTO sats_bot_memory_messages (bot_id, id, event_key, kind, text, date)
      VALUES ('personal', 1, 'event', 'user', 'Remember this', '2026-10-24')`;
    yield* sql`UPDATE effect_sql_migrations SET created_at = '2026-10-20 00:00:00'
      WHERE migration_id >= 68`;
    const bots = yield* sql`SELECT * FROM sats_bots`;
    const memory = yield* sql`SELECT * FROM sats_bot_memory_messages`;
    yield* runMigrations();
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sats_bots`, bots);
    assert.deepStrictEqual(yield* sql`SELECT * FROM sats_bot_memory_messages`, memory);
    const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
    assert.deepStrictEqual(history.map((row) => [row.migration_id, row.name]), migrationManifest);
    assert.deepStrictEqual(
      yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 69`,
      [{ created_at: "2026-10-20 00:00:00" }],
    );
    assert.strictEqual(
      (yield* sql`SELECT name FROM sqlite_master WHERE type = 'index'
        AND name = 'orchestration_v2_projection_turn_items_stop_request_idx'`).length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects unknown later fork history without changing data or history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    yield* Migrator.make({})({ loader: Migrator.fromRecord({ "68_BotChat": BotChat }) });
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'Unknown')`;
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const error = yield* runMigrations().pipe(Effect.flip);
    assert.strictEqual(error._tag, "MigrationError");
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`, before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
