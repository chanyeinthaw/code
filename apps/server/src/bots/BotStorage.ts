import {
  BotChatError,
  BotId,
  BotIdentity,
  MemoryJob,
  MemoryMessage,
  MemoryNode,
  MemorySnapshot,
  MemoryState,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const emptyState = (): MemoryState => ({
  parts: [],
  pending: false,
  revision: 0,
  compactParts: [],
  compactPending: false,
  compactRevision: -1,
  total: 0,
  frontier: 0,
});
const stateJson = Schema.fromJsonString(MemoryState);
const isBotChatError = Schema.is(BotChatError);
const decodeBotIdentityRows = Schema.decodeUnknownEffect(Schema.Array(BotIdentity));
const decodeMemoryNodeRows = Schema.decodeUnknownEffect(Schema.Array(MemoryNode));
const decodeMemoryJobRows = Schema.decodeUnknownEffect(Schema.Array(MemoryJob));
const decodeMemoryMessageRows = Schema.decodeUnknownEffect(Schema.Array(MemoryMessage));
const decodeMemorySnapshotRows = Schema.decodeUnknownEffect(Schema.Array(MemorySnapshot));
const encodeName = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const encodeState = Schema.encodeEffect(stateJson);
const decodeState = Schema.decodeEffect(stateJson);

const database =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isBotChatError(cause) ? cause : new BotChatError({ operation, reason: "storage", cause }),
      ),
    );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
  const withBot = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    locks.withPermit(id)(effect);
  const identityColumns = sql.literal(
    `id,name,owner_environment_id AS "ownerEnvironmentId",thread_id AS "threadId",generation,status,destination_environment_id AS "destinationEnvironmentId"`,
  );
  const list = Effect.fn("BotStorage.list")(function* () {
    return yield* decodeBotIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_bots ORDER BY name,id`,
    );
  }, database("list"));
  const get = Effect.fn("BotStorage.get")(function* (id: BotId) {
    const rows = yield* decodeBotIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_bots WHERE id=${id}`,
    );
    if (!rows[0]) return yield* new BotChatError({ operation: "get", reason: "not-found" });
    return rows[0];
  }, database("get"));
  const forThread = Effect.fn("BotStorage.forThread")(function* (threadId: ThreadId) {
    return (yield* decodeBotIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_bots WHERE thread_id=${threadId}`,
    ))[0];
  }, database("for-thread"));
  const create = Effect.fn("BotStorage.create")(function* (identity: BotIdentity) {
    yield* sql`INSERT INTO sats_bots(id,name,owner_environment_id,thread_id,generation,status,state_json)
      VALUES (${identity.id},${identity.name},${identity.ownerEnvironmentId},${identity.threadId},${identity.generation},'active',${yield* encodeState(emptyState())})`;
    return identity;
  }, database("create"));
  const clearHistory = Effect.fn("BotStorage.clearHistory")(function* (id: BotId) {
    yield* sql`DELETE FROM sats_bot_memory_snapshots WHERE bot_id=${id}`;
    yield* sql`DELETE FROM sats_bot_memory_jobs WHERE bot_id=${id}`;
    yield* sql`DELETE FROM sats_bot_memory_nodes WHERE bot_id=${id}`;
    yield* sql`DELETE FROM sats_bot_memory_messages WHERE bot_id=${id}`;
  });
  const reset = Effect.fn("BotStorage.reset")(function* (id: BotId, threadId: ThreadId) {
    yield* clearHistory(id);
    yield* sql`UPDATE sats_bots SET thread_id=${threadId},generation=generation+1,
      state_json=${yield* encodeState(emptyState())},last_sequence=0 WHERE id=${id}`;
    return yield* get(id);
  }, database("reset"));
  const remove = Effect.fn("BotStorage.remove")(function* (id: BotId) {
    yield* clearHistory(id);
    yield* sql`DELETE FROM sats_bot_transfer_chunks WHERE transfer_id IN
      (SELECT transfer_id FROM sats_bots WHERE id=${id})`;
    // Keep a newer tombstone so another connected environment cannot advertise a stale copy.
    yield* sql`UPDATE sats_bots SET status='deleted',generation=generation+1,
      state_json=${yield* encodeState(emptyState())},last_sequence=0,
      transfer_json=NULL,release_secret=NULL,release_hash=NULL WHERE id=${id}`;
  }, database("delete"));
  const memory = Effect.fn("BotStorage.memory")(function* (id: BotId) {
    const rows = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM sats_bots WHERE id=${id}`;
    if (!rows[0]) return yield* new BotChatError({ operation: "memory", reason: "not-found" });
    const state = yield* decodeState(rows[0].state_json);
    const [totals, missing] = yield* Effect.all([
      sql<{
        total: number;
      }>`SELECT COALESCE(MAX(id)+1,0) AS total FROM sats_bot_memory_messages WHERE bot_id=${id}`,
      sql<{
        frontier: number | null;
      }>`SELECT MIN(id) AS frontier FROM sats_bot_memory_jobs WHERE bot_id=${id} AND count=1`,
    ]);
    const total = totals[0]?.total ?? 0;
    return { ...state, total, frontier: missing[0]?.frontier ?? total };
  }, database("memory"));
  const saveMemory = Effect.fn("BotStorage.saveMemory")(function* (id: BotId, state: MemoryState) {
    yield* sql`UPDATE sats_bots SET state_json=${yield* encodeState(state)} WHERE id=${id}`;
  }, database("save-memory"));
  const appendMessages = Effect.fn("BotStorage.appendMessages")(function* (
    id: BotId,
    messages: readonly Omit<MemoryMessage, "id">[],
  ) {
    const owner = yield* get(id);
    if (owner.status !== "active")
      return yield* new BotChatError({ operation: "append", reason: "not-owner" });
    const state = yield* memory(id);
    const parts = [...state.parts];
    let next = state.total;
    for (const message of messages) {
      const exists =
        yield* sql`SELECT 1 FROM sats_bot_memory_messages WHERE bot_id=${id} AND event_key=${message.key}`;
      if (exists.length) continue;
      // Bound a single compaction input without discarding Unicode or tool output.
      const characters = Array.from(message.text);
      const pages = Math.max(1, Math.ceil(characters.length / 30_000));
      for (let page = 0; page < pages; page++) {
        const text = characters.slice(page * 30_000, (page + 1) * 30_000).join("");
        const key = page === 0 ? message.key : `${message.key}:part:${page}`;
        yield* sql`INSERT INTO sats_bot_memory_messages(bot_id,id,event_key,kind,text,date)
          VALUES (${id},${next},${key},${message.kind},${text},${message.date})`;
        yield* sql`INSERT INTO sats_bot_memory_jobs(bot_id,id,count,source)
          VALUES (${id},${next},1,${`${message.kind}: ${text}`})`;
        parts.push({ id: next++, count: 1 });
      }
    }
    yield* saveMemory(id, { ...state, parts, total: next });
  });
  const append = Effect.fn("BotStorage.append")(
    (id: BotId, messages: readonly Omit<MemoryMessage, "id">[]) =>
      withBot(id, sql.withTransaction(appendMessages(id, messages))),
    database("append"),
  );
  const rename = Effect.fn("BotStorage.rename")(
    (id: BotId, name: string, eventKey: string, date: string) =>
      withBot(
        id,
        sql.withTransaction(
          Effect.gen(function* () {
            const bot = yield* get(id);
            if (
              bot.name === name ||
              (yield* sql`SELECT 1 FROM sats_bot_memory_messages WHERE bot_id=${id} AND event_key=${eventKey}`)
                .length > 0
            )
              return;
            const oldName = yield* encodeName(bot.name);
            const newName = yield* encodeName(name);
            yield* appendMessages(id, [
              {
                key: eventKey,
                kind: "echo",
                text: `Your name changed from ${oldName} to ${newName}. Your name is now ${newName}.`,
                date,
              },
            ]);
            yield* sql`UPDATE sats_bots SET name=${name} WHERE id=${id}`;
          }),
        ),
      ),
    database("rename"),
  );
  const memoryNodes = Effect.fn("BotStorage.memoryNodes")(function* (
    id: BotId,
    parts: readonly { id: number; count: number }[],
  ) {
    const rows = yield* Effect.forEach(
      parts,
      (part) =>
        sql`SELECT id,count,text FROM sats_bot_memory_nodes WHERE bot_id=${id} AND id=${part.id} AND count=${part.count}`,
    );
    return yield* decodeMemoryNodeRows(rows.flat());
  }, database("nodes"));
  const memoryJobs = Effect.fn("BotStorage.memoryJobs")(function* (id: BotId, capacity: number) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const jobs = yield* decodeMemoryJobRows(
          yield* sql`SELECT id,count,source FROM sats_bot_memory_jobs WHERE bot_id=${id} AND status='queued'
          AND EXISTS(SELECT 1 FROM sats_bots WHERE id=${id} AND status='active')
          AND (count>1 OR id<=COALESCE((SELECT id FROM sats_bot_memory_jobs
            WHERE bot_id=${id} AND count=1 ORDER BY id LIMIT 1 OFFSET 7),
            (SELECT COALESCE(MAX(id)+1,0) FROM sats_bot_memory_messages WHERE bot_id=${id})))
          ORDER BY count,id LIMIT ${capacity}`,
        );
        for (const job of jobs)
          yield* sql`UPDATE sats_bot_memory_jobs SET status='running' WHERE bot_id=${id} AND id=${job.id} AND count=${job.count}`;
        return jobs;
      }),
    );
  }, database("jobs"));
  const completeMemoryJob = Effect.fn("BotStorage.completeMemoryJob")(function* (
    id: BotId,
    node: MemoryNode,
  ) {
    yield* withBot(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO sats_bot_memory_nodes(bot_id,id,count,text) VALUES (${id},${node.id},${node.count},${node.text})`;
          yield* sql`DELETE FROM sats_bot_memory_jobs WHERE bot_id=${id} AND id=${node.id} AND count=${node.count}`;
          const parent = Math.floor(node.id / (node.count * 2)) * node.count * 2;
          yield* sql`INSERT OR IGNORE INTO sats_bot_memory_jobs(bot_id,id,count,source)
        SELECT a.bot_id,a.id,a.count*2,a.text || char(10) || b.text
        FROM sats_bot_memory_nodes a JOIN sats_bot_memory_nodes b
        ON b.bot_id=a.bot_id AND b.count=a.count AND b.id=a.id+a.count
        LEFT JOIN sats_bot_memory_nodes p ON p.bot_id=a.bot_id AND p.id=a.id AND p.count=a.count*2
        WHERE a.bot_id=${id} AND a.id=${parent} AND a.count=${node.count} AND p.id IS NULL`;
        }),
      ),
    );
  }, database("complete-job"));
  const failMemoryJob = Effect.fn("BotStorage.failMemoryJob")(function* (
    id: BotId,
    part: { id: number; count: number },
  ) {
    yield* sql`UPDATE sats_bot_memory_jobs SET status='failed' WHERE bot_id=${id} AND id=${part.id} AND count=${part.count}`;
  }, database("fail-job"));
  const retryMemoryJobs = Effect.fn("BotStorage.retryMemoryJobs")(function* (
    id: BotId,
    force = false,
  ) {
    if (force)
      yield* sql`UPDATE sats_bot_memory_jobs SET status='queued' WHERE bot_id=${id} AND status='failed'`;
  }, database("retry-jobs"));
  const memoryRecoveryDue = Effect.fn("BotStorage.memoryRecoveryDue")(function* (id: BotId) {
    return (
      (yield* sql`SELECT 1 FROM sats_bot_memory_jobs WHERE bot_id=${id} AND status='queued' LIMIT 1`)
        .length > 0
    );
  }, database("recovery-due"));
  const message = Effect.fn("BotStorage.message")(function* (id: BotId, index: number) {
    return (yield* decodeMemoryMessageRows(
      yield* sql`SELECT id,event_key AS key,kind,text,date FROM sats_bot_memory_messages WHERE bot_id=${id} AND id=${index}`,
    ))[0];
  }, database("message"));
  const snapshot = Effect.fn("BotStorage.snapshot")(function* (id: BotId, runId: RunId) {
    return (yield* decodeMemorySnapshotRows(
      yield* sql`SELECT bot_id AS "botId",run_id AS "runId",total,view FROM sats_bot_memory_snapshots WHERE bot_id=${id} AND run_id=${runId}`,
    ))[0];
  }, database("snapshot"));
  const freeze = Effect.fn("BotStorage.freeze")(function* (frozen: MemorySnapshot) {
    yield* sql`INSERT OR IGNORE INTO sats_bot_memory_snapshots(bot_id,run_id,total,view)
      VALUES (${frozen.botId},${frozen.runId},${frozen.total},${frozen.view})`;
    const saved = yield* snapshot(frozen.botId, frozen.runId);
    if (!saved) return yield* new BotChatError({ operation: "freeze", reason: "storage" });
    return saved;
  }, database("freeze"));
  const freezeAndAppend = Effect.fn("BotStorage.freezeAndAppend")(
    (frozen: MemorySnapshot, message: Omit<MemoryMessage, "id">) =>
      withBot(
        frozen.botId,
        sql.withTransaction(
          Effect.gen(function* () {
            const saved = yield* freeze(frozen);
            yield* appendMessages(frozen.botId, [message]);
            return saved;
          }),
        ),
      ),
    database("freeze-and-append"),
  );
  const cursor = Effect.fn("BotStorage.cursor")(function* (id: BotId) {
    return (
      (yield* sql<{
        last_sequence: number;
      }>`SELECT last_sequence FROM sats_bots WHERE id=${id}`)[0]?.last_sequence ?? 0
    );
  }, database("cursor"));
  const advance = Effect.fn("BotStorage.advance")(function* (id: BotId, sequence: number) {
    yield* sql`UPDATE sats_bots SET last_sequence=MAX(last_sequence,${sequence}) WHERE id=${id}`;
  }, database("advance"));
  // A process restart abandons only execution claims, never the durable jobs.
  yield* sql`UPDATE sats_bot_memory_jobs SET status='queued' WHERE status='running'`.pipe(
    database("recover"),
  );
  return {
    cursor,
    advance,
    list,
    get,
    forThread,
    create,
    reset,
    rename,
    remove,
    memory,
    saveMemory,
    append,
    withBot,
    memoryNodes,
    memoryJobs,
    completeMemoryJob,
    failMemoryJob,
    retryMemoryJobs,
    memoryRecoveryDue,
    message,
    snapshot,
    freeze,
    freezeAndAppend,
  };
});

export class BotStorage extends Context.Service<BotStorage, Effect.Success<typeof make>>()(
  "t3/bots/BotStorage",
) {}
export const layer = Layer.effect(BotStorage, make);
