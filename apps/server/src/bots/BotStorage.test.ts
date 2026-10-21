import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  BotChatError,
  BotId,
  RunId,
  ThreadId,
  type BotIdentity,
} from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@satslab/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/069_BotChat.ts";
import * as BotStorage from "./BotStorage.ts";
import { makeMemory } from "./MemoryWorker.ts";
import { memoryTools } from "./MemoryTools.ts";

const database = Layer.effectDiscard(migration).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const layer = BotStorage.layer.pipe(Layer.provideMerge(database));
const identity: BotIdentity = {
  id: BotId.make("bot-test"),
  name: "Personal",
  ownerEnvironmentId: EnvironmentId.make("owner"),
  threadId: ThreadId.make("thread-test"),
  generation: 0,
  status: "active",
  destinationEnvironmentId: null,
};
const message = (key: string, text = key) => ({
  key,
  text,
  kind: "user" as const,
  date: "2026-10-19T00:00:00.000Z",
});

it.effect("rolls back a rename and its journal entry when the transaction fails", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    const sql = yield* SqlClient.SqlClient;
    yield* storage.create(identity);
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* storage.rename(identity.id, "Atlas", "rename:failed", "2026-10-21T00:00:00.000Z");
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal((yield* storage.get(identity.id)).name, "Personal");
    assert.equal((yield* storage.memory(identity.id)).total, 0);
    assert.deepEqual(yield* storage.memoryJobs(identity.id, 8), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("appends originals once and builds immutable sibling summaries", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    yield* Effect.all(
      [
        storage.append(identity.id, [message("first"), message("second")]),
        storage.append(identity.id, [message("first", "duplicate")]),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal((yield* storage.memory(identity.id)).total, 2);
    assert.equal((yield* storage.message(identity.id, 0))?.text, "first");
    const jobs = yield* storage.memoryJobs(identity.id, 8);
    assert.equal(jobs.length, 2);
    assert.deepEqual(yield* storage.memoryJobs(identity.id, 8), []);
    yield* storage.completeMemoryJob(identity.id, { id: 0, count: 1, text: "original summary" });
    yield* storage.completeMemoryJob(identity.id, { id: 0, count: 1, text: "replacement" });
    yield* storage.completeMemoryJob(identity.id, { id: 1, count: 1, text: "second summary" });
    assert.deepEqual(yield* storage.memoryJobs(identity.id, 8), [
      { id: 0, count: 2, source: "original summary\nsecond summary" },
    ]);
  }).pipe(Effect.provide(Layer.merge(layer, NodeCrypto.layer))),
);

it.effect("freezes a retry-stable view and commits its current input atomically", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    const frozen = {
      botId: identity.id,
      runId: RunId.make("run-test"),
      total: 0,
      view: "<chat>\n\n</chat>",
    };
    yield* storage.freezeAndAppend(frozen, message("current"));
    assert.deepEqual(
      yield* storage.freezeAndAppend({ ...frozen, total: 1, view: "changed" }, message("current")),
      frozen,
    );
    assert.equal((yield* storage.memory(identity.id)).total, 1);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE sats_bots SET status='transferring' WHERE id=${identity.id}`;
    const rejected = yield* Effect.result(
      storage.freezeAndAppend({ ...frozen, runId: RunId.make("other") }, message("next")),
    );
    assert.equal(rejected._tag, "Failure");
    assert.isUndefined(yield* storage.snapshot(identity.id, RunId.make("other")));
  }).pipe(Effect.provide(Layer.merge(layer, NodeCrypto.layer))),
);

it.effect("drains compaction and bounds navigation to the frozen high-water mark", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    yield* storage.append(identity.id, [message("first"), message("long", "word ".repeat(300))]);
    const tasks: string[] = [];
    const worker = yield* makeMemory(identity.id, () =>
      Effect.succeed({
        send: (task) =>
          Effect.sync(() => {
            tasks.push(task);
            return "user: long message";
          }),
      }),
    );
    const view = yield* worker.settle();
    assert.include(view, "0+1|user: first");
    assert.include(view, "1+1|user: long message");
    assert.isAbove(tasks.length, 0);
    yield* storage.append(identity.id, [message("future")]);
    const tools = memoryTools(storage, identity.id);
    assert.equal(yield* tools.zoom(1, 1, 2), "word ".repeat(300));
    assert.equal((yield* Effect.result(tools.zoom(2, 1, 2)))._tag, "Failure");
    assert.equal((yield* Effect.result(tools.zoom(1, 2, 3)))._tag, "Failure");
    assert.equal(yield* tools.date(0, 2), "2026-10-19T00:00:00.000Z");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeCrypto.layer))),
);

it.effect("retains originals and retries failed compactions without freezing placeholders", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    yield* storage.append(identity.id, [message("long", "x".repeat(2000))]);
    let failing = true;
    const worker = yield* makeMemory(identity.id, () =>
      Effect.succeed({
        send: () =>
          failing
            ? Effect.fail(new BotChatError({ operation: "compact", reason: "inference" }))
            : Effect.succeed("user: recovered"),
      }),
    );
    assert.equal((yield* Effect.result(worker.settle()))._tag, "Failure");
    assert.equal((yield* storage.message(identity.id, 0))?.text.length, 2000);
    failing = false;
    assert.include(yield* worker.settle(), "0+1|user: recovered");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeCrypto.layer))),
);

it.effect("retains the shortest summary after five attempts without retrying it next turn", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    yield* storage.append(identity.id, [message("long", "x".repeat(2000))]);
    const lengths = [900, 600, 800, 550, 700];
    let calls = 0;
    const worker = yield* makeMemory(identity.id, () =>
      Effect.succeed({
        send: () => Effect.sync(() => "x".repeat(lengths[calls++] ?? 1000)),
      }),
    );
    const view = yield* worker.settle();
    assert.include(view, `0+1|${"x".repeat(550)}\n`);
    assert.equal(calls, 5);
    assert.equal((yield* storage.message(identity.id, 0))?.text, "x".repeat(2000));
    assert.equal(yield* worker.settle(), view);
    assert.equal(calls, 5);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeCrypto.layer))),
);

it.effect(
  "splits oversized originals without losing Unicode and keeps append retries idempotent",
  () =>
    Effect.gen(function* () {
      const storage = yield* BotStorage.BotStorage;
      yield* storage.create(identity);
      const text = "🪻abc".repeat(20_001);
      yield* storage.append(identity.id, [message("oversized", text)]);
      yield* storage.append(identity.id, [message("oversized", text)]);
      const state = yield* storage.memory(identity.id);
      assert.equal(state.total, 3);
      const originals = yield* Effect.forEach([0, 1, 2], (id) => storage.message(identity.id, id));
      assert.equal(originals.map((original) => original?.text).join(""), text);
      assert.equal((yield* storage.memoryJobs(identity.id, 8)).length, 3);
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps later leaves behind the earliest eight unresolved messages", () =>
  Effect.gen(function* () {
    const storage = yield* BotStorage.BotStorage;
    yield* storage.create(identity);
    yield* storage.append(
      identity.id,
      Array.from({ length: 20 }, (_, id) => message(String(id))),
    );
    const first = yield* storage.memoryJobs(identity.id, 8);
    assert.deepEqual(
      first.map((job) => job.id),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    for (const job of first) yield* storage.failMemoryJob(identity.id, job);
    assert.deepEqual(yield* storage.memoryJobs(identity.id, 8), []);
    yield* storage.retryMemoryJobs(identity.id, true);
    assert.deepEqual(yield* storage.memoryJobs(identity.id, 8), first);
    yield* storage.completeMemoryJob(identity.id, { id: 0, count: 1, text: "Recovered" });
    const next = yield* storage.memoryJobs(identity.id, 8);
    assert.deepEqual(
      next.map((job) => job.id),
      [8],
    );
    assert.equal((yield* storage.memory(identity.id)).frontier, 1);
  }).pipe(Effect.provide(layer)),
);
