import {
  BotChatError,
  MemoryState,
  MemoryMessage,
  MemoryNode,
  MemoryJob,
  MemorySnapshot,
  BotTransfer,
  type BotId,
  type EnvironmentId,
} from "@satslab/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { validRange } from "./MemoryTree.ts";
import * as BotStorage from "./BotStorage.ts";

const isBotChatError = Schema.is(BotChatError);
const decodeMemoryNodeRows = Schema.decodeUnknownEffect(Schema.Array(MemoryNode));
const decodeMemoryJobRows = Schema.decodeUnknownEffect(Schema.Array(MemoryJob));
const decodeMemoryMessageRows = Schema.decodeUnknownEffect(Schema.Array(MemoryMessage));
const decodeMemorySnapshotRows = Schema.decodeUnknownEffect(Schema.Array(MemorySnapshot));
const decodeTransfer = Schema.decodeUnknownEffect(Schema.fromJsonString(BotTransfer));
const encodeTransfer = Schema.encodeEffect(Schema.fromJsonString(BotTransfer));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(MemoryState));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* BotStorage.BotStorage;
  const crypto = yield* Crypto.Crypto;
  const hash = (secret: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(secret))
      .pipe(Effect.map((digest) => Buffer.from(digest).toString("hex")));
  const invalid = () => new BotChatError({ operation: "transfer", reason: "invalid-transfer" });
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotChatError(cause)
          ? cause
          : new BotChatError({ operation: "transfer", reason: "storage", cause }),
      ),
    );
  const prepare = Effect.fn("BotOwnership.prepare")(function* (
    id: BotId,
    destination: EnvironmentId,
  ) {
    return yield* storage.withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          const identity = yield* storage.get(id);
          if (
            identity.ownerEnvironmentId === destination ||
            (identity.status !== "active" &&
              !(
                identity.status === "transferring" &&
                identity.destinationEnvironmentId === destination
              ))
          )
            return yield* invalid();
          if (identity.status === "active") {
            const transferId = yield* crypto.randomUUIDv4();
            const secret = yield* crypto.randomUUIDv4();
            const digest = yield* hash(secret);
            yield* sql`UPDATE sats_bots SET status='transferring',destination_environment_id=${destination},transfer_id=${transferId},release_secret=${secret},release_hash=${digest},transfer_json=NULL,transfer_imported=0 WHERE id=${id}`;
          }
          const rows = yield* sql<{
            transfer_id: string;
            release_hash: string;
          }>`SELECT transfer_id,release_hash FROM sats_bots WHERE id=${id}`;
          const row = rows[0];
          if (!row) return yield* invalid();
          return {
            transferId: row.transfer_id,
            releaseHash: row.release_hash,
            destinationEnvironmentId: destination,
            identity: {
              ...identity,
              status: "staged" as const,
              ownerEnvironmentId: destination,
              destinationEnvironmentId: null,
              generation: identity.generation + 1,
            },
            state: yield* storage.memory(id),
            messages: yield* decodeMemoryMessageRows(
              yield* sql`SELECT id,event_key AS key,kind,text,date FROM sats_bot_memory_messages WHERE bot_id=${id} ORDER BY id`,
            ),
            nodes: yield* decodeMemoryNodeRows(
              yield* sql`SELECT id,count,text FROM sats_bot_memory_nodes WHERE bot_id=${id} ORDER BY count,id`,
            ),
            jobs: yield* decodeMemoryJobRows(
              yield* sql`SELECT id,count,source FROM sats_bot_memory_jobs WHERE bot_id=${id} ORDER BY count,id`,
            ),
            snapshots: yield* decodeMemorySnapshotRows(
              yield* sql`SELECT bot_id AS "botId",run_id AS "runId",total,view FROM sats_bot_memory_snapshots WHERE bot_id=${id}`,
            ),
          };
        }),
      ),
    );
  }, wrap);
  const packageFor = Effect.fn("BotOwnership.packageFor")(function* (id: BotId) {
    const rows = yield* sql<{
      transfer_json: string | null;
    }>`SELECT transfer_json FROM sats_bots WHERE id=${id}`;
    return rows[0]?.transfer_json
      ? yield* decodeTransfer(Buffer.from(rows[0].transfer_json, "base64").toString("utf8"))
      : undefined;
  }, wrap);
  const savePackage = Effect.fn("BotOwnership.savePackage")(function* (transfer: BotTransfer) {
    const encoded = yield* encodeTransfer(transfer);
    yield* sql`UPDATE sats_bots SET transfer_json=${Buffer.from(encoded).toString("base64")} WHERE id=${transfer.identity.id} AND transfer_id=${transfer.transferId}`;
  }, wrap);
  const stage = Effect.fn("BotOwnership.stage")(function* (
    transfer: BotTransfer,
    environmentId: EnvironmentId,
  ) {
    if (
      transfer.destinationEnvironmentId !== environmentId ||
      transfer.identity.ownerEnvironmentId !== environmentId ||
      transfer.identity.status !== "staged"
    )
      return yield* invalid();
    const id = transfer.identity.id;
    if (
      transfer.state.total !== transfer.messages.length ||
      transfer.messages.some((message, index) => message.id !== index) ||
      transfer.snapshots.some(
        (snapshot) => snapshot.botId !== id || snapshot.total > transfer.state.total,
      )
    )
      return yield* invalid();
    let covered = 0;
    for (const part of transfer.state.parts) {
      if (part.id !== covered || !validRange(part.id, part.count, transfer.state.total))
        return yield* invalid();
      covered += part.count;
    }
    if (
      covered !== transfer.state.total ||
      [...transfer.nodes, ...transfer.jobs].some(
        (part) => !validRange(part.id, part.count, transfer.state.total),
      )
    )
      return yield* invalid();
    return yield* storage.withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<{
            generation: number;
            transfer_id: string | null;
            status: string;
          }>`SELECT generation,transfer_id,status FROM sats_bots WHERE id=${id}`;
          const previous = existing[0];
          if (
            previous?.transfer_id === transfer.transferId &&
            previous.generation === transfer.identity.generation
          ) {
            const saved = yield* packageFor(id);
            if (!saved || (yield* encodeTransfer(saved)) !== (yield* encodeTransfer(transfer)))
              return yield* invalid();
            return yield* storage.get(id);
          }
          if (
            previous &&
            (!["forwarded", "staged"].includes(previous.status) ||
              previous.generation > transfer.identity.generation ||
              (previous.status === "forwarded" &&
                previous.generation === transfer.identity.generation))
          )
            return yield* invalid();
          // A returned identity replaces only its inactive replica, never an active owner.
          if (previous) {
            yield* sql`DELETE FROM sats_bot_memory_messages WHERE bot_id=${id}`;
            yield* sql`DELETE FROM sats_bot_memory_nodes WHERE bot_id=${id}`;
            yield* sql`DELETE FROM sats_bot_memory_jobs WHERE bot_id=${id}`;
            yield* sql`DELETE FROM sats_bot_memory_snapshots WHERE bot_id=${id}`;
            yield* sql`DELETE FROM sats_bots WHERE id=${id}`;
          }
          const identity = transfer.identity;
          const state = yield* encodeState(transfer.state);
          yield* sql`INSERT INTO sats_bots(id,name,owner_environment_id,thread_id,generation,status,state_json,transfer_id,release_hash)
        VALUES (${id},${identity.name},${environmentId},${identity.threadId},${identity.generation},'staged',${state},${transfer.transferId},${transfer.releaseHash})`;
          for (const message of transfer.messages)
            yield* sql`INSERT INTO sats_bot_memory_messages(bot_id,id,event_key,kind,text,date) VALUES (${id},${message.id},${message.key},${message.kind},${message.text},${message.date})`;
          for (const node of transfer.nodes)
            yield* sql`INSERT INTO sats_bot_memory_nodes(bot_id,id,count,text) VALUES (${id},${node.id},${node.count},${node.text})`;
          for (const job of transfer.jobs)
            yield* sql`INSERT INTO sats_bot_memory_jobs(bot_id,id,count,source) VALUES (${id},${job.id},${job.count},${job.source})`;
          for (const snapshot of transfer.snapshots)
            yield* sql`INSERT INTO sats_bot_memory_snapshots(bot_id,run_id,total,view) VALUES (${id},${snapshot.runId},${snapshot.total},${snapshot.view})`;
          yield* savePackage(transfer);
          return yield* storage.get(id);
        }),
      ),
    );
  }, wrap);
  const release = Effect.fn("BotOwnership.release")(function* (id: BotId, transferId: string) {
    return yield* storage.withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            transfer_id: string;
            release_secret: string;
            status: string;
            destination_environment_id: string | null;
          }>`SELECT transfer_id,release_secret,status,destination_environment_id FROM sats_bots WHERE id=${id}`;
          const row = rows[0];
          if (
            !row ||
            row.transfer_id !== transferId ||
            !row.release_secret ||
            !row.destination_environment_id ||
            !["transferring", "forwarded"].includes(row.status)
          )
            return yield* invalid();
          if (!(yield* packageFor(id))) return yield* invalid();
          if (row.status === "transferring")
            yield* sql`UPDATE sats_bots SET status='forwarded',owner_environment_id=destination_environment_id,generation=generation+1 WHERE id=${id}`;
          return { secret: row.release_secret };
        }),
      ),
    );
  }, wrap);
  const activate = Effect.fn("BotOwnership.activate")(function* (
    id: BotId,
    transferId: string,
    secret: string,
    environmentId: EnvironmentId,
  ) {
    const digest = yield* hash(secret);
    return yield* storage.withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          const identity = yield* storage.get(id);
          const rows = yield* sql<{
            transfer_id: string;
            release_hash: string;
            transfer_imported: number;
          }>`SELECT transfer_id,release_hash,transfer_imported FROM sats_bots WHERE id=${id}`;
          const row = rows[0];
          if (
            !row ||
            row.transfer_imported !== 1 ||
            identity.ownerEnvironmentId !== environmentId ||
            row.transfer_id !== transferId ||
            row.release_hash !== digest ||
            !["staged", "active"].includes(identity.status)
          )
            return yield* invalid();
          yield* sql`UPDATE sats_bots SET status='active' WHERE id=${id}`;
          return yield* storage.get(id);
        }),
      ),
    );
  }, wrap);
  const cancel = Effect.fn("BotOwnership.cancel")(function* (
    id: BotId,
    transferId: string,
    environmentId: EnvironmentId,
  ) {
    return yield* storage.withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          const identity = yield* storage.get(id);
          const rows = yield* sql<{
            transfer_id: string;
          }>`SELECT transfer_id FROM sats_bots WHERE id=${id}`;
          if (
            rows[0]?.transfer_id !== transferId ||
            identity.ownerEnvironmentId !== environmentId ||
            identity.status !== "transferring"
          )
            return yield* invalid();
          yield* sql`UPDATE sats_bots SET status='active',destination_environment_id=NULL,transfer_id=NULL,release_secret=NULL,release_hash=NULL,transfer_json=NULL WHERE id=${id}`;
          return yield* storage.get(id);
        }),
      ),
    );
  }, wrap);
  const completeImport = Effect.fn("BotOwnership.completeImport")(function* (
    id: BotId,
    transferId: string,
  ) {
    yield* sql`UPDATE sats_bots SET transfer_imported=1 WHERE id=${id} AND transfer_id=${transferId} AND status='staged'`;
  }, wrap);
  const describe = Effect.fn("BotOwnership.describe")(function* (id: BotId, transferId: string) {
    const rows = yield* sql<{
      length: number;
    }>`SELECT length(transfer_json) AS length FROM sats_bots WHERE id=${id} AND transfer_id=${transferId}`;
    if (!rows[0]?.length) return yield* invalid();
    return { transferId, length: rows[0].length, chunkSize: 262144 };
  }, wrap);
  const readChunk = Effect.fn("BotOwnership.readChunk")(function* (
    id: BotId,
    transferId: string,
    offset: number,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0) return yield* invalid();
    const rows = yield* sql<{
      data: string;
    }>`SELECT substr(transfer_json,${offset + 1},262144) AS data FROM sats_bots WHERE id=${id} AND transfer_id=${transferId}`;
    if (!rows[0]?.data) return yield* invalid();
    return { data: rows[0].data, nextOffset: offset + rows[0].data.length };
  }, wrap);
  const writeChunk = Effect.fn("BotOwnership.writeChunk")(function* (
    transferId: string,
    offset: number,
    data: string,
  ) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      data.length === 0 ||
      data.length > 262144 ||
      !/^[A-Za-z0-9+/=]+$/.test(data)
    )
      return yield* invalid();
    const rows = yield* sql<{
      data: string;
    }>`SELECT data FROM sats_bot_transfer_chunks WHERE transfer_id=${transferId} AND offset=${offset}`;
    if (rows[0] && rows[0].data !== data) return yield* invalid();
    yield* sql`INSERT OR IGNORE INTO sats_bot_transfer_chunks(transfer_id,offset,data) VALUES (${transferId},${offset},${data})`;
  }, wrap);
  const readIncoming = Effect.fn("BotOwnership.readIncoming")(function* (
    transferId: string,
    length: number,
  ) {
    const chunks = yield* sql<{
      offset: number;
      data: string;
    }>`SELECT offset,data FROM sats_bot_transfer_chunks WHERE transfer_id=${transferId} ORDER BY offset`;
    let covered = 0;
    for (const chunk of chunks) {
      if (chunk.offset !== covered) return yield* invalid();
      covered += chunk.data.length;
    }
    if (covered !== length || length === 0) return yield* invalid();
    const transfer = yield* decodeTransfer(
      Buffer.from(chunks.map((chunk) => chunk.data).join(""), "base64").toString("utf8"),
    );
    if (transfer.transferId !== transferId) return yield* invalid();
    return transfer;
  }, wrap);
  return {
    prepare,
    stage,
    release,
    activate,
    cancel,
    packageFor,
    savePackage,
    completeImport,
    describe,
    readChunk,
    writeChunk,
    readIncoming,
  };
});
export class BotOwnership extends Context.Service<BotOwnership, Effect.Success<typeof make>>()(
  "@satslab/sora/bots/BotOwnership",
) {}
export const layer = Layer.effect(BotOwnership, make);
