import {
  MemoryChatError,
  MemoryId,
  MemoryIdentity,
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
const isMemoryChatError = Schema.is(MemoryChatError);
const decodeMemoryIdentityRows = Schema.decodeUnknownEffect(Schema.Array(MemoryIdentity));
const decodeMemoryNodeRows = Schema.decodeUnknownEffect(Schema.Array(MemoryNode));
const decodeMemoryJobRows = Schema.decodeUnknownEffect(Schema.Array(MemoryJob));
const decodeMemoryMessageRows = Schema.decodeUnknownEffect(Schema.Array(MemoryMessage));
const decodeMemorySnapshotRows = Schema.decodeUnknownEffect(Schema.Array(MemorySnapshot));
const encodeState = Schema.encodeEffect(stateJson);
const decodeState = Schema.decodeEffect(stateJson);

const database =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isMemoryChatError(cause)
          ? cause
          : new MemoryChatError({ operation, reason: "storage", cause }),
      ),
    );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 });
  const withMemory = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    locks.withPermit(id)(effect);
  const identityColumns = sql.literal(
    `id,name,owner_environment_id AS "ownerEnvironmentId",thread_id AS "threadId",generation,status,destination_environment_id AS "destinationEnvironmentId"`,
  );
  const list = Effect.fn("MemoryStorage.list")(function* () {
    return yield* decodeMemoryIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_memories ORDER BY name,id`,
    );
  }, database("list"));
  const get = Effect.fn("MemoryStorage.get")(function* (id: MemoryId) {
    const rows = yield* decodeMemoryIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_memories WHERE id=${id}`,
    );
    if (!rows[0]) return yield* new MemoryChatError({ operation: "get", reason: "not-found" });
    return rows[0];
  }, database("get"));
  const forThread = Effect.fn("MemoryStorage.forThread")(function* (threadId: ThreadId) {
    return (yield* decodeMemoryIdentityRows(
      yield* sql`SELECT ${identityColumns} FROM sats_memories WHERE thread_id=${threadId}`,
    ))[0];
  }, database("for-thread"));
  const create = Effect.fn("MemoryStorage.create")(function* (identity: MemoryIdentity) {
    yield* sql`INSERT INTO sats_memories(id,name,owner_environment_id,thread_id,generation,status,state_json)
      VALUES (${identity.id},${identity.name},${identity.ownerEnvironmentId},${identity.threadId},${identity.generation},'active',${yield* encodeState(emptyState())})`;
    return identity;
  }, database("create"));
  const clearHistory = Effect.fn("MemoryStorage.clearHistory")(function* (id: MemoryId) {
    yield* sql`DELETE FROM sats_memory_snapshots WHERE memory_id=${id}`;
    yield* sql`DELETE FROM sats_memory_jobs WHERE memory_id=${id}`;
    yield* sql`DELETE FROM sats_memory_nodes WHERE memory_id=${id}`;
    yield* sql`DELETE FROM sats_memory_messages WHERE memory_id=${id}`;
  });
  const reset = Effect.fn("MemoryStorage.reset")(function* (id: MemoryId, threadId: ThreadId) {
    yield* clearHistory(id);
    yield* sql`UPDATE sats_memories SET thread_id=${threadId},generation=generation+1,
      state_json=${yield* encodeState(emptyState())},last_sequence=0 WHERE id=${id}`;
    return yield* get(id);
  }, database("reset"));
  const remove = Effect.fn("MemoryStorage.remove")(function* (id: MemoryId) {
    yield* clearHistory(id);
    yield* sql`DELETE FROM sats_memory_transfer_chunks WHERE transfer_id IN
      (SELECT transfer_id FROM sats_memories WHERE id=${id})`;
    // Keep a newer tombstone so another connected environment cannot advertise a stale copy.
    yield* sql`UPDATE sats_memories SET status='deleted',generation=generation+1,
      state_json=${yield* encodeState(emptyState())},last_sequence=0,
      transfer_json=NULL,release_secret=NULL,release_hash=NULL WHERE id=${id}`;
  }, database("delete"));
  const memory = Effect.fn("MemoryStorage.memory")(function* (id: MemoryId) {
    const rows = yield* sql<{
      state_json: string;
    }>`SELECT state_json FROM sats_memories WHERE id=${id}`;
    if (!rows[0]) return yield* new MemoryChatError({ operation: "memory", reason: "not-found" });
    const state = yield* decodeState(rows[0].state_json);
    const [totals, missing] = yield* Effect.all([
      sql<{
        total: number;
      }>`SELECT COALESCE(MAX(id)+1,0) AS total FROM sats_memory_messages WHERE memory_id=${id}`,
      sql<{
        frontier: number | null;
      }>`SELECT MIN(id) AS frontier FROM sats_memory_jobs WHERE memory_id=${id} AND count=1`,
    ]);
    const total = totals[0]?.total ?? 0;
    return { ...state, total, frontier: missing[0]?.frontier ?? total };
  }, database("memory"));
  const saveMemory = Effect.fn("MemoryStorage.saveMemory")(function* (
    id: MemoryId,
    state: MemoryState,
  ) {
    yield* sql`UPDATE sats_memories SET state_json=${yield* encodeState(state)} WHERE id=${id}`;
  }, database("save-memory"));
  const appendMessages = Effect.fn("MemoryStorage.appendMessages")(function* (
    id: MemoryId,
    messages: readonly Omit<MemoryMessage, "id">[],
  ) {
    const owner = yield* get(id);
    if (owner.status !== "active")
      return yield* new MemoryChatError({ operation: "append", reason: "not-owner" });
    const state = yield* memory(id);
    const parts = [...state.parts];
    let next = state.total;
    for (const message of messages) {
      const exists =
        yield* sql`SELECT 1 FROM sats_memory_messages WHERE memory_id=${id} AND event_key=${message.key}`;
      if (exists.length) continue;
      // Bound a single compaction input without discarding Unicode or tool output.
      const characters = Array.from(message.text);
      const pages = Math.max(1, Math.ceil(characters.length / 30_000));
      for (let page = 0; page < pages; page++) {
        const text = characters.slice(page * 30_000, (page + 1) * 30_000).join("");
        const key = page === 0 ? message.key : `${message.key}:part:${page}`;
        yield* sql`INSERT INTO sats_memory_messages(memory_id,id,event_key,kind,text,date)
          VALUES (${id},${next},${key},${message.kind},${text},${message.date})`;
        yield* sql`INSERT INTO sats_memory_jobs(memory_id,id,count,source)
          VALUES (${id},${next},1,${`${message.kind}: ${text}`})`;
        parts.push({ id: next++, count: 1 });
      }
    }
    yield* saveMemory(id, { ...state, parts, total: next });
  });
  const append = Effect.fn("MemoryStorage.append")(
    (id: MemoryId, messages: readonly Omit<MemoryMessage, "id">[]) =>
      withMemory(id, sql.withTransaction(appendMessages(id, messages))),
    database("append"),
  );
  const memoryNodes = Effect.fn("MemoryStorage.memoryNodes")(function* (
    id: MemoryId,
    parts: readonly { id: number; count: number }[],
  ) {
    const rows = yield* Effect.forEach(
      parts,
      (part) =>
        sql`SELECT id,count,text FROM sats_memory_nodes WHERE memory_id=${id} AND id=${part.id} AND count=${part.count}`,
    );
    return yield* decodeMemoryNodeRows(rows.flat());
  }, database("nodes"));
  const memoryJobs = Effect.fn("MemoryStorage.memoryJobs")(function* (
    id: MemoryId,
    capacity: number,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const jobs = yield* decodeMemoryJobRows(
          yield* sql`SELECT id,count,source FROM sats_memory_jobs WHERE memory_id=${id} AND status='queued'
          AND EXISTS(SELECT 1 FROM sats_memories WHERE id=${id} AND status='active')
          AND (count>1 OR id<=COALESCE((SELECT id FROM sats_memory_jobs
            WHERE memory_id=${id} AND count=1 ORDER BY id LIMIT 1 OFFSET 7),
            (SELECT COALESCE(MAX(id)+1,0) FROM sats_memory_messages WHERE memory_id=${id})))
          ORDER BY count,id LIMIT ${capacity}`,
        );
        for (const job of jobs)
          yield* sql`UPDATE sats_memory_jobs SET status='running' WHERE memory_id=${id} AND id=${job.id} AND count=${job.count}`;
        return jobs;
      }),
    );
  }, database("jobs"));
  const completeMemoryJob = Effect.fn("MemoryStorage.completeMemoryJob")(function* (
    id: MemoryId,
    node: MemoryNode,
  ) {
    yield* withMemory(
      id,
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO sats_memory_nodes(memory_id,id,count,text) VALUES (${id},${node.id},${node.count},${node.text})`;
          yield* sql`DELETE FROM sats_memory_jobs WHERE memory_id=${id} AND id=${node.id} AND count=${node.count}`;
          const parent = Math.floor(node.id / (node.count * 2)) * node.count * 2;
          yield* sql`INSERT OR IGNORE INTO sats_memory_jobs(memory_id,id,count,source)
        SELECT a.memory_id,a.id,a.count*2,a.text || char(10) || b.text
        FROM sats_memory_nodes a JOIN sats_memory_nodes b
        ON b.memory_id=a.memory_id AND b.count=a.count AND b.id=a.id+a.count
        LEFT JOIN sats_memory_nodes p ON p.memory_id=a.memory_id AND p.id=a.id AND p.count=a.count*2
        WHERE a.memory_id=${id} AND a.id=${parent} AND a.count=${node.count} AND p.id IS NULL`;
        }),
      ),
    );
  }, database("complete-job"));
  const failMemoryJob = Effect.fn("MemoryStorage.failMemoryJob")(function* (
    id: MemoryId,
    part: { id: number; count: number },
  ) {
    yield* sql`UPDATE sats_memory_jobs SET status='failed' WHERE memory_id=${id} AND id=${part.id} AND count=${part.count}`;
  }, database("fail-job"));
  const retryMemoryJobs = Effect.fn("MemoryStorage.retryMemoryJobs")(function* (
    id: MemoryId,
    force = false,
  ) {
    if (force)
      yield* sql`UPDATE sats_memory_jobs SET status='queued' WHERE memory_id=${id} AND status='failed'`;
  }, database("retry-jobs"));
  const memoryRecoveryDue = Effect.fn("MemoryStorage.memoryRecoveryDue")(function* (id: MemoryId) {
    return (
      (yield* sql`SELECT 1 FROM sats_memory_jobs WHERE memory_id=${id} AND status='queued' LIMIT 1`)
        .length > 0
    );
  }, database("recovery-due"));
  const message = Effect.fn("MemoryStorage.message")(function* (id: MemoryId, index: number) {
    return (yield* decodeMemoryMessageRows(
      yield* sql`SELECT id,event_key AS key,kind,text,date FROM sats_memory_messages WHERE memory_id=${id} AND id=${index}`,
    ))[0];
  }, database("message"));
  const snapshot = Effect.fn("MemoryStorage.snapshot")(function* (id: MemoryId, runId: RunId) {
    return (yield* decodeMemorySnapshotRows(
      yield* sql`SELECT memory_id AS "memoryId",run_id AS "runId",total,view FROM sats_memory_snapshots WHERE memory_id=${id} AND run_id=${runId}`,
    ))[0];
  }, database("snapshot"));
  const freeze = Effect.fn("MemoryStorage.freeze")(function* (frozen: MemorySnapshot) {
    yield* sql`INSERT OR IGNORE INTO sats_memory_snapshots(memory_id,run_id,total,view)
      VALUES (${frozen.memoryId},${frozen.runId},${frozen.total},${frozen.view})`;
    const saved = yield* snapshot(frozen.memoryId, frozen.runId);
    if (!saved) return yield* new MemoryChatError({ operation: "freeze", reason: "storage" });
    return saved;
  }, database("freeze"));
  const freezeAndAppend = Effect.fn("MemoryStorage.freezeAndAppend")(
    (frozen: MemorySnapshot, message: Omit<MemoryMessage, "id">) =>
      withMemory(
        frozen.memoryId,
        sql.withTransaction(
          Effect.gen(function* () {
            const saved = yield* freeze(frozen);
            yield* appendMessages(frozen.memoryId, [message]);
            return saved;
          }),
        ),
      ),
    database("freeze-and-append"),
  );
  const cursor = Effect.fn("MemoryStorage.cursor")(function* (id: MemoryId) {
    return (
      (yield* sql<{
        last_sequence: number;
      }>`SELECT last_sequence FROM sats_memories WHERE id=${id}`)[0]?.last_sequence ?? 0
    );
  }, database("cursor"));
  const advance = Effect.fn("MemoryStorage.advance")(function* (id: MemoryId, sequence: number) {
    yield* sql`UPDATE sats_memories SET last_sequence=MAX(last_sequence,${sequence}) WHERE id=${id}`;
  }, database("advance"));
  // A process restart abandons only execution claims, never the durable jobs.
  yield* sql`UPDATE sats_memory_jobs SET status='queued' WHERE status='running'`.pipe(
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
    remove,
    memory,
    saveMemory,
    append,
    withMemory,
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

export class MemoryStorage extends Context.Service<MemoryStorage, Effect.Success<typeof make>>()(
  "t3/memory/MemoryStorage",
) {}
export const layer = Layer.effect(MemoryStorage, make);
