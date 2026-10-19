import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  BotId,
  MessageId,
  RunId,
  ThreadId,
  type BotIdentity,
  type BotTransfer,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/068_BotChat.ts";
import * as BotStorage from "./BotStorage.ts";
import * as BotOwnership from "./BotOwnership.ts";

const database = () =>
  Layer.effectDiscard(migration).pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
const environment = () =>
  BotOwnership.layer.pipe(
    Layer.provideMerge(BotStorage.layer),
    Layer.provideMerge(database()),
    Layer.provide(NodeCrypto.layer),
  );
const owner = EnvironmentId.make("owner");
const destination = EnvironmentId.make("destination");
const identity: BotIdentity = {
  id: BotId.make("personal"),
  name: "Personal",
  ownerEnvironmentId: owner,
  threadId: ThreadId.make("memory-thread"),
  generation: 0,
  status: "active",
  destinationEnvironmentId: null,
};
const message = {
  key: "first",
  kind: "user" as const,
  text: "Remember this",
  date: "2026-10-19T00:00:00.000Z",
};

it.effect("transfers durable history with no simultaneous owners and resumes lost replies", () =>
  Effect.gen(function* () {
    const sourceContext = yield* Layer.build(environment());
    const destinationContext = yield* Layer.build(environment());
    const source = Context.get(sourceContext, BotOwnership.BotOwnership);
    const target = Context.get(destinationContext, BotOwnership.BotOwnership);
    const sourceStorage = Context.get(sourceContext, BotStorage.BotStorage);
    const targetStorage = Context.get(destinationContext, BotStorage.BotStorage);
    yield* sourceStorage.create(identity);
    yield* sourceStorage.append(identity.id, [message]);
    yield* sourceStorage.freeze({
      botId: identity.id,
      runId: RunId.make("frozen"),
      total: 1,
      view: "old view",
    });
    const core = yield* source.prepare(identity.id, destination);
    // Real history carries timestamps, which must survive the package's JSON form.
    const now = yield* DateTime.now;
    const transfer: BotTransfer = {
      ...core,
      events: [
        {
          id: EventId.make("history"),
          threadId: identity.threadId,
          occurredAt: now,
          type: "message.updated",
          payload: {
            id: MessageId.make("history"),
            threadId: identity.threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: message.text,
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      project: {
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        projectIcon: null,
        scripts: [],
        settingsOverrides: {},
      },
    };
    yield* source.savePackage(transfer);
    assert.equal((yield* sourceStorage.get(identity.id)).status, "transferring");
    assert.equal(
      (yield* Effect.result(sourceStorage.append(identity.id, [{ ...message, key: "blocked" }])))
        ._tag,
      "Failure",
    );
    const descriptor = yield* source.describe(identity.id, transfer.transferId);
    const chunk = yield* source.readChunk(identity.id, transfer.transferId, 0);
    yield* target.writeChunk(transfer.transferId, 0, chunk.data);
    yield* target.writeChunk(transfer.transferId, 0, chunk.data);
    assert.equal(
      (yield* Effect.result(target.readIncoming(transfer.transferId, descriptor.length + 1)))._tag,
      "Failure",
    );
    const received = yield* target.readIncoming(transfer.transferId, descriptor.length);
    yield* target.stage(received, destination);
    yield* target.stage(received, destination);
    assert.equal((yield* targetStorage.get(identity.id)).status, "staged");
    assert.equal(
      (yield* Effect.result(
        target.activate(identity.id, transfer.transferId, "forged", destination),
      ))._tag,
      "Failure",
    );
    const released = yield* source.release(identity.id, transfer.transferId);
    assert.deepEqual(yield* source.release(identity.id, transfer.transferId), released);
    assert.equal((yield* sourceStorage.get(identity.id)).status, "forwarded");
    assert.equal(
      (yield* Effect.result(source.cancel(identity.id, transfer.transferId, owner)))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(
        target.activate(identity.id, transfer.transferId, released.secret, destination),
      ))._tag,
      "Failure",
    );
    yield* target.completeImport(identity.id, transfer.transferId);
    const active = yield* target.activate(
      identity.id,
      transfer.transferId,
      released.secret,
      destination,
    );
    assert.equal(active.status, "active");
    assert.equal(active.generation, 1);
    assert.equal(active.ownerEnvironmentId, destination);
    assert.deepEqual(
      yield* target.activate(identity.id, transfer.transferId, released.secret, destination),
      active,
    );
    assert.equal((yield* targetStorage.message(identity.id, 0))?.text, message.text);
    assert.equal(
      (yield* targetStorage.snapshot(identity.id, RunId.make("frozen")))?.view,
      "old view",
    );
    assert.equal((yield* targetStorage.memoryJobs(identity.id, 8)).length, 1);
    assert.deepEqual(yield* source.packageFor(identity.id), transfer);
    const returnedCore = yield* target.prepare(identity.id, owner);
    assert.isUndefined(yield* target.packageFor(identity.id));
    const returned: BotTransfer = {
      ...returnedCore,
      events: [],
      project: {
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        projectIcon: null,
        scripts: [],
        settingsOverrides: {},
      },
    };
    yield* target.savePackage(returned);
    assert.equal((yield* Effect.result(target.stage(returned, owner)))._tag, "Failure");
    yield* source.stage(returned, owner);
    assert.equal((yield* sourceStorage.get(identity.id)).status, "staged");
    const returnedRelease = yield* target.release(identity.id, returned.transferId);
    yield* source.completeImport(identity.id, returned.transferId);
    const returnedIdentity = yield* source.activate(
      identity.id,
      returned.transferId,
      returnedRelease.secret,
      owner,
    );
    assert.equal(returnedIdentity.generation, 2);
    assert.equal(returnedIdentity.status, "active");
    assert.equal((yield* targetStorage.get(identity.id)).status, "forwarded");
    assert.equal((yield* sourceStorage.message(identity.id, 0))?.text, message.text);
  }).pipe(Effect.scoped),
);

it.effect("allows cancellation before release and rejects broken tree coverage", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(environment());
    const source = Context.get(context, BotOwnership.BotOwnership);
    const storage = Context.get(context, BotStorage.BotStorage);
    yield* storage.create(identity);
    yield* storage.append(identity.id, [message]);
    const core = yield* source.prepare(identity.id, destination);
    const broken: BotTransfer = {
      ...core,
      state: { ...core.state, parts: [] },
      events: [],
      project: {
        defaultModelSelection: null,
        defaultThreadEnvMode: null,
        autoPull: false,
        projectIcon: null,
        scripts: [],
        settingsOverrides: {},
      },
    };
    assert.equal((yield* Effect.result(source.stage(broken, destination)))._tag, "Failure");
    const restored = yield* source.cancel(identity.id, core.transferId, owner);
    assert.equal(restored.status, "active");
    yield* storage.append(identity.id, [{ ...message, key: "second" }]);
    assert.equal((yield* storage.memory(identity.id)).total, 2);
    assert.isUndefined(yield* source.packageFor(identity.id));
  }).pipe(Effect.scoped),
);

it.effect(
  "replaces an abandoned staged copy after cancellation and rejects conflicting retries",
  () =>
    Effect.gen(function* () {
      const sourceContext = yield* Layer.build(environment());
      const destinationContext = yield* Layer.build(environment());
      const source = Context.get(sourceContext, BotOwnership.BotOwnership);
      const target = Context.get(destinationContext, BotOwnership.BotOwnership);
      const storage = Context.get(sourceContext, BotStorage.BotStorage);
      yield* storage.create(identity);
      yield* storage.append(identity.id, [message]);
      const first: BotTransfer = {
        ...(yield* source.prepare(identity.id, destination)),
        events: [],
        project: {
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          projectIcon: null,
          scripts: [],
          settingsOverrides: {},
        },
      };
      yield* source.savePackage(first);
      yield* target.stage(first, destination);
      assert.equal(
        (yield* Effect.result(
          target.stage({ ...first, identity: { ...first.identity, name: "Changed" } }, destination),
        ))._tag,
        "Failure",
      );
      yield* source.cancel(identity.id, first.transferId, owner);
      yield* storage.append(identity.id, [
        { ...message, key: "after-cancel", text: "New history" },
      ]);
      const second: BotTransfer = {
        ...(yield* source.prepare(identity.id, destination)),
        events: [],
        project: {
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          projectIcon: null,
          scripts: [],
          settingsOverrides: {},
        },
      };
      yield* source.savePackage(second);
      yield* target.stage(second, destination);
      assert.equal(
        (yield* Effect.result(
          target.activate(identity.id, first.transferId, "old-proof", destination),
        ))._tag,
        "Failure",
      );
      const proof = yield* source.release(identity.id, second.transferId);
      yield* target.completeImport(identity.id, second.transferId);
      assert.equal(
        (yield* target.activate(identity.id, second.transferId, proof.secret, destination)).status,
        "active",
      );
      const targetStorage = Context.get(destinationContext, BotStorage.BotStorage);
      assert.equal((yield* targetStorage.message(identity.id, 1))?.text, "New history");
    }).pipe(Effect.scoped),
);
