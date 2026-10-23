import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE bot_discord_settings (bot_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE bot_discord_routes (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, route_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX bot_discord_routes_bot ON bot_discord_routes(bot_id)`;
  yield* sql`CREATE TABLE bot_discord_messages (
    bot_id TEXT NOT NULL, message_id TEXT NOT NULL, route_id TEXT NOT NULL,
    PRIMARY KEY (bot_id, message_id)
  )`;
  yield* sql`CREATE TABLE bot_discord_replies (
    bot_id TEXT NOT NULL, reply_id TEXT NOT NULL, route_id TEXT NOT NULL,
    kind TEXT NOT NULL, text TEXT NOT NULL, message_ids_json TEXT NOT NULL,
    PRIMARY KEY (bot_id, reply_id)
  )`;
});
