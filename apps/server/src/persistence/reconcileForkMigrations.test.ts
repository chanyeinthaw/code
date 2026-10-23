import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@satslab/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import BotChat from "./Migrations/069_BotChat.ts";
import BotProjects from "./Migrations/070_BotProjects.ts";
import OutgoingWebhooks from "./Migrations/071_OutgoingWebhooks.ts";
import OutgoingWebhookEndpointUrl from "./Migrations/072_OutgoingWebhookEndpointUrl.ts";
import BotIntegrations from "./Migrations/073_BotIntegrations.ts";

it.effect.each([68, 69, 70, 71, 72])(
  "upgrades shipped Sora migration history through %s",
  (lastId) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* Migrator.make({})({
        loader: Migrator.fromRecord({
          "68_BotChat": BotChat,
          ...(lastId >= 69 ? { "69_BotProjects": BotProjects } : {}),
          ...(lastId >= 70 ? { "70_OutgoingWebhooks": OutgoingWebhooks } : {}),
          ...(lastId >= 71 ? { "71_OutgoingWebhookEndpointUrl": OutgoingWebhookEndpointUrl } : {}),
          ...(lastId >= 72 ? { "72_BotIntegrations": BotIntegrations } : {}),
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
      if (lastId >= 70) {
        yield* sql`INSERT INTO outgoing_webhooks
        (id, name, enabled, events_json, template, preview_length, endpoint_origin, header_names_json, created_at, updated_at)
        VALUES ('existing', 'Existing', 1, '["completed"]', '{}', 500, 'https://hooks.example.test', '[]', '2026-10-20', '2026-10-20')`;
        yield* sql`INSERT INTO outgoing_webhook_jobs
        (id, webhook_id, dedupe_key, event_type, context_json, status, next_attempt_at, created_at, updated_at)
        VALUES ('job', 'existing', 'dedupe', 'completed', '{}', 'queued', 0, '2026-10-20', '2026-10-20')`;
      }
      if (lastId >= 71) {
        yield* sql`UPDATE outgoing_webhooks SET endpoint_url = 'https://hooks.example.test/path'`;
      }
      if (lastId >= 72) {
        yield* sql`INSERT INTO bot_discord_settings VALUES ('personal', '{"enabled":true}')`;
        yield* sql`INSERT INTO bot_discord_routes VALUES ('route', 'personal', '{}')`;
        yield* sql`INSERT INTO bot_discord_messages VALUES ('personal', 'message', 'route')`;
        yield* sql`INSERT INTO bot_discord_replies VALUES ('personal', 'reply', 'route', 'text', 'Saved reply', '["message"]')`;
      }
      const jobs = lastId >= 70 ? yield* sql`SELECT * FROM outgoing_webhook_jobs` : [];
      const replies = lastId >= 72 ? yield* sql`SELECT * FROM bot_discord_replies` : [];
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrations(), []);
      if (lastId >= 70) {
        assert.deepStrictEqual(yield* sql`SELECT * FROM outgoing_webhook_jobs`, jobs);
        assert.deepStrictEqual(
          yield* sql`SELECT endpoint_origin, endpoint_url FROM outgoing_webhooks`,
          [
            {
              endpoint_origin: "https://hooks.example.test",
              endpoint_url: lastId >= 71 ? "https://hooks.example.test/path" : null,
            },
          ],
        );
      }
      if (lastId >= 72) {
        assert.deepStrictEqual(yield* sql`SELECT * FROM bot_discord_replies`, replies);
        assert.deepStrictEqual(yield* sql`SELECT * FROM bot_discord_routes`, [
          { id: "route", bot_id: "personal", route_json: "{}" },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM bot_discord_settings`, [
          { bot_id: "personal", settings_json: '{"enabled":true}' },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT * FROM bot_discord_messages`, [
          { bot_id: "personal", message_id: "message", route_id: "route" },
        ]);
      }
      assert.deepStrictEqual(yield* sql`SELECT * FROM sats_bots`, bots);
      assert.deepStrictEqual(yield* sql`SELECT * FROM sats_bot_memory_messages`, memory);
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
    `;
      assert.deepStrictEqual(
        history.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
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
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      before,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
