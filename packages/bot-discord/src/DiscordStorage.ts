import {
  BotDiscordSettings,
  BotId,
  BotIntegrationError,
  DEFAULT_BOT_DISCORD_SETTINGS,
} from "@satslab/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { DiscordRoute } from "./model.ts";

const settingsCodec = Schema.fromJsonString(BotDiscordSettings);
const routeCodec = Schema.fromJsonString(DiscordRoute);
const idsCodec = Schema.fromJsonString(Schema.Array(Schema.String));
const Reply = Schema.Struct({
  routeId: Schema.String,
  kind: Schema.Literals(["progress", "answer"]),
  text: Schema.String,
  messageIds: Schema.Array(Schema.String),
});
export type Reply = typeof Reply.Type;
const decodeConfigured = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ botId: BotId })));
const decodeReply = Schema.decodeUnknownEffect(Reply);
const persisted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) => new BotIntegrationError({ operation: "storage", reason: "storage", cause }),
    ),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = Effect.fn("DiscordStorage.settings")(function* (botId: BotId) {
    const rows = yield* sql<{
      settings_json: string;
    }>`SELECT settings_json FROM bot_discord_settings WHERE bot_id=${botId}`;
    return rows[0]
      ? yield* Schema.decodeEffect(settingsCodec)(rows[0].settings_json)
      : DEFAULT_BOT_DISCORD_SETTINGS;
  }, persisted);
  const configure = Effect.fn("DiscordStorage.configure")(function* (
    botId: BotId,
    value: BotDiscordSettings,
  ) {
    const json = yield* Schema.encodeEffect(settingsCodec)(value);
    yield* sql`INSERT INTO bot_discord_settings(bot_id,settings_json) VALUES (${botId},${json})
      ON CONFLICT(bot_id) DO UPDATE SET settings_json=excluded.settings_json`;
  }, persisted);
  const configured = Effect.fn("DiscordStorage.configured")(function* () {
    return yield* decodeConfigured(yield* sql`SELECT bot_id AS "botId" FROM bot_discord_settings`);
  }, persisted);
  const route = Effect.fn("DiscordStorage.route")(function* (id: string) {
    const rows = yield* sql<{
      route_json: string;
    }>`SELECT route_json FROM bot_discord_routes WHERE id=${id}`;
    return rows[0] ? yield* Schema.decodeEffect(routeCodec)(rows[0].route_json) : undefined;
  }, persisted);
  const pending = Effect.fn("DiscordStorage.pending")(function* (botId: BotId) {
    const rows = yield* sql<{ route_json: string }>`SELECT route_json FROM bot_discord_routes
      WHERE bot_id=${botId} AND json_extract(route_json, '$.delivered')=0 ORDER BY rowid`;
    return yield* Effect.forEach(rows, (row) => Schema.decodeEffect(routeCodec)(row.route_json));
  }, persisted);
  const messageRoute = Effect.fn("DiscordStorage.messageRoute")(function* (
    botId: BotId,
    messageId: string,
  ) {
    const rows = yield* sql<{ route_json: string }>`SELECT r.route_json FROM bot_discord_messages m
      JOIN bot_discord_routes r ON r.id=m.route_id WHERE m.bot_id=${botId} AND m.message_id=${messageId}`;
    return rows[0] ? yield* Schema.decodeEffect(routeCodec)(rows[0].route_json) : undefined;
  }, persisted);
  const rememberMessage = Effect.fn("DiscordStorage.rememberMessage")(function* (
    botId: BotId,
    messageId: string,
    routeId: string,
  ) {
    yield* sql`INSERT INTO bot_discord_messages(bot_id,message_id,route_id) VALUES (${botId},${messageId},${routeId})
      ON CONFLICT(bot_id,message_id) DO NOTHING`;
  }, persisted);
  const saveRoute = Effect.fn("DiscordStorage.saveRoute")(function* (value: DiscordRoute) {
    const json = yield* Schema.encodeEffect(routeCodec)(value);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO bot_discord_routes(id,bot_id,route_json) VALUES (${value.id},${value.botId},${json})
        ON CONFLICT(id) DO UPDATE SET route_json=excluded.route_json`;
        yield* rememberMessage(value.botId, value.triggerId, value.id);
      }),
    );
  }, persisted);
  const reply = Effect.fn("DiscordStorage.reply")(function* (botId: BotId, replyId: string) {
    const rows = yield* sql<{
      routeId: string;
      kind: string;
      text: string;
      message_ids_json: string;
    }>`
      SELECT route_id AS "routeId",kind,text,message_ids_json FROM bot_discord_replies WHERE bot_id=${botId} AND reply_id=${replyId}`;
    const row = rows[0];
    if (!row) return undefined;
    return yield* decodeReply({
      ...row,
      messageIds: yield* Schema.decodeEffect(idsCodec)(row.message_ids_json),
    });
  }, persisted);
  const saveReply = Effect.fn("DiscordStorage.saveReply")(function* (
    botId: BotId,
    replyId: string,
    value: Reply,
  ) {
    const json = yield* Schema.encodeEffect(idsCodec)(value.messageIds);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO bot_discord_replies(bot_id,reply_id,route_id,kind,text,message_ids_json)
        VALUES (${botId},${replyId},${value.routeId},${value.kind},${value.text},${json})
        ON CONFLICT(bot_id,reply_id) DO UPDATE SET message_ids_json=excluded.message_ids_json`;
        for (const id of value.messageIds) yield* rememberMessage(botId, id, value.routeId);
      }),
    );
  }, persisted);
  const clearRoutes = Effect.fn("DiscordStorage.clearRoutes")(function* (botId: BotId) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM bot_discord_messages WHERE bot_id=${botId}`;
        yield* sql`DELETE FROM bot_discord_replies WHERE bot_id=${botId}`;
        yield* sql`DELETE FROM bot_discord_routes WHERE bot_id=${botId}`;
      }),
    );
  }, persisted);
  return {
    settings,
    configure,
    configured,
    route,
    pending,
    messageRoute,
    rememberMessage,
    saveRoute,
    reply,
    saveReply,
    clearRoutes,
  };
});

export class DiscordStorage extends Context.Service<DiscordStorage, Effect.Success<typeof make>>()(
  "@satslab/bot-discord/DiscordStorage",
) {}
export const layer = Layer.effect(DiscordStorage, make);
