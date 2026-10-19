import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";

const shippedForkMigrations = new Map([
  [68, "BotChat"],
  [69, "BotProjects"],
]);

// Shipped Sora builds used upstream's new id 68 for BotChat. Move only the
// recognized history, preserving schemas, data, and migration timestamps.
export const reconcileForkMigrations = Effect.fn("reconcileForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return;
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
        ORDER BY migration_id DESC
      `;
      if (!history.some((row) => row.migration_id === 68 && row.name === "BotChat")) return;
      if (history.some((row) => shippedForkMigrations.get(row.migration_id) !== row.name)) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade Sora with unexpected later migrations.",
        });
      }
      for (const row of history) {
        yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 1}
          WHERE migration_id = ${row.migration_id}`;
      }
      yield* ShellStopRequestIndex;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (68, 'ShellStopRequestIndex')`;
    }),
  );
});
