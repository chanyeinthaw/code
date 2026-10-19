import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import CodexUsageNativeTurnIndex from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import RepairClientSettlementTimestamps from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import WebhookDedupe from "./Migrations/067_WebhookDedupe.ts";

// Earlier sats builds used 65 and 66 before upstream assigned those ids.
export const reconcileSatsMemoryMigrations = Effect.fn("reconcileSatsMemoryMigrations")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 65
      `;
      if (!history.some((row) => row.migration_id === 65 && row.name === "MemoryChat")) return [];
      if (
        (throughId !== undefined && throughId < 69) ||
        !history.every(
          (row) =>
            (row.migration_id === 65 && row.name === "MemoryChat") ||
            (row.migration_id === 66 && row.name === "MemoryProjects"),
        )
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot upgrade sats memory migration history without a complete, known upgrade path.",
        });
      }
      yield* CodexUsageNativeTurnIndex;
      yield* RepairClientSettlementTimestamps;
      yield* WebhookDedupe;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 69 WHERE migration_id = 66 AND name = 'MemoryProjects'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 68 WHERE migration_id = 65 AND name = 'MemoryChat'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (65, 'CodexUsageNativeTurnIndex'), (66, 'RepairClientSettlementTimestamps'), (67, 'WebhookDedupe')`;
      return [
        [65, "CodexUsageNativeTurnIndex"],
        [66, "RepairClientSettlementTimestamps"],
        [67, "WebhookDedupe"],
      ] as const;
    }),
  );
});
