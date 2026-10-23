import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Delivery from "./OutgoingWebhookDelivery.ts";
import {
  OUTGOING_WEBHOOK_ALERT_WINDOW,
  OutgoingWebhookRepository,
} from "./OutgoingWebhookRepository.ts";
import * as Service from "./OutgoingWebhookService.ts";
import {
  assistantMessage,
  makeHarness,
  makeThread,
  runtimeRequest,
  runUpdated,
  SECRET_URL,
  threadCreated,
  webhookInput,
} from "./OutgoingWebhookTestkit.ts";

const jobsFor = (repository: OutgoingWebhookRepository["Service"], webhookId: string) =>
  repository.history(webhookId as never, 50);

describe("outgoing webhook alerts", () => {
  it.effect("queues one job per finished run, even when the run is updated again", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const { webhook } = yield* service.upsert(webhookInput());
      const thread = makeThread("thread:one", { title: 'Fix "login"' });
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          assistantMessage(thread.id, "All done."),
        ],
      });
      assert.lengthOf(yield* jobsFor(repository, webhook.id), 0);

      yield* sink.write({ events: [runUpdated(thread.id, 1, "completed")] });
      yield* sink.write({ events: [runUpdated(thread.id, 1, "completed", 1)] });
      const queued = yield* jobsFor(repository, webhook.id);
      assert.lengthOf(queued, 1);
      assert.equal(queued[0]?.eventType, "completed");

      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);
      const sent = harness.requests[0]!;
      assert.equal(sent.url, SECRET_URL);
      assert.equal(sent.headers["authorization"], "Bearer header-secret-456");
      assert.equal(sent.headers["idempotency-key"], queued[0]?.id);
      assert.deepEqual(JSON.parse(sent.body), {
        title: 'Fix "login"',
        body: "All done.",
        url: "https://sora.example.test/env-test/thread%3Aone",
      });
      const [finished] = yield* jobsFor(repository, webhook.id);
      assert.equal(finished?.status, "succeeded");
      assert.equal(finished?.httpStatus, 200);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("notifies each approval and input request once, and ignores a settled thread", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* service.upsert(webhookInput());
      const thread = makeThread("thread:requests");
      yield* sink.write({ events: [threadCreated(thread), runUpdated(thread.id, 1, "running")] });

      yield* sink.write({ events: [runtimeRequest(thread.id, "req-1", "command", "pending")] });
      yield* sink.write({ events: [runtimeRequest(thread.id, "req-1", "command", "pending", 1)] });
      yield* sink.write({ events: [runtimeRequest(thread.id, "req-1", "command", "resolved")] });
      yield* sink.write({ events: [runtimeRequest(thread.id, "req-2", "command", "pending")] });
      yield* sink.write({ events: [runtimeRequest(thread.id, "req-2", "command", "resolved")] });
      yield* sink.write({ events: [runtimeRequest(thread.id, "req-3", "user_input", "pending")] });

      const types = (yield* jobsFor(repository, webhook.id)).map((job) => job.eventType).sort();
      assert.deepEqual(types, ["approval_required", "approval_required", "input_required"]);

      const settled = makeThread("thread:settled", { settledOverride: "settled" });
      yield* sink.write({
        events: [
          threadCreated(settled),
          runUpdated(settled.id, 1, "running"),
          runUpdated(settled.id, 1, "completed"),
        ],
      });
      const subagent = makeThread("thread:sub", {
        lineage: {
          parentThreadId: thread.id,
          relationshipToParent: "subagent",
          rootThreadId: thread.id,
        },
      });
      yield* sink.write({
        events: [
          threadCreated(subagent),
          runUpdated(subagent.id, 1, "running"),
          runUpdated(subagent.id, 1, "completed"),
        ],
      });
      assert.lengthOf(yield* jobsFor(repository, webhook.id), 3);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("only queues for the events a webhook selected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* service.upsert(webhookInput({ events: ["failed"] }));
      const thread = makeThread("thread:select");
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          runUpdated(thread.id, 1, "completed"),
        ],
      });
      assert.lengthOf(yield* jobsFor(repository, webhook.id), 0);
      const failing = makeThread("thread:select-failed");
      yield* sink.write({
        events: [
          threadCreated(failing),
          runUpdated(failing.id, 1, "running"),
          runUpdated(failing.id, 1, "failed"),
        ],
      });
      const jobs = yield* jobsFor(repository, webhook.id);
      assert.deepEqual(
        jobs.map((job) => job.eventType),
        ["failed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("outgoing webhook delivery", () => {
  const completeOneThread = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(webhookInput());
      const thread = makeThread("thread:delivery");
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          runUpdated(thread.id, 1, "completed"),
        ],
      });
      return { webhook, thread, sink, harness };
    });

  it.effect("retries transient failures with the same Idempotency-Key, then succeeds", () => {
    const harness = makeHarness({
      script: (attempt) => (attempt === 1 ? 503 : attempt === 2 ? 429 : 200),
    });
    return Effect.gen(function* () {
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* completeOneThread(harness);

      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);
      const [afterFirst] = yield* jobsFor(repository, webhook.id);
      assert.equal(afterFirst?.status, "queued");
      assert.equal(afterFirst?.failure, "server_error");

      // Not due yet: nothing is resent until the backoff passes.
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);

      yield* TestClock.adjust("10 seconds");
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 2);
      assert.equal((yield* jobsFor(repository, webhook.id))[0]?.failure, "rate_limited");

      yield* TestClock.adjust("1 minute");
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 3);
      const [done] = yield* jobsFor(repository, webhook.id);
      assert.equal(done?.status, "succeeded");
      assert.equal(done?.attempts, 3);
      assert.equal(
        new Set(harness.requests.map((request) => request.headers["idempotency-key"])).size,
        1,
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not retry a rejection, and stores a category rather than the response", () => {
    const harness = makeHarness({ script: () => 400 });
    return Effect.gen(function* () {
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* completeOneThread(harness);
      yield* delivery.drain;
      yield* TestClock.adjust("1 hour");
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);
      const history = yield* jobsFor(repository, webhook.id);
      assert.equal(history[0]?.status, "failed");
      assert.equal(history[0]?.failure, "rejected");
      assert.equal(history[0]?.httpStatus, 400);
      assert.notInclude(JSON.stringify(history), "very-secret-token");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("gives up after the attempt limit when the network keeps failing", () => {
    const harness = makeHarness({ script: () => "network-error" });
    return Effect.gen(function* () {
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* completeOneThread(harness);
      for (let pass = 0; pass < Delivery.MAX_OUTGOING_WEBHOOK_ATTEMPTS + 2; pass++) {
        yield* delivery.drain;
        yield* TestClock.adjust("20 minutes");
      }
      assert.lengthOf(harness.requests, Delivery.MAX_OUTGOING_WEBHOOK_ATTEMPTS);
      const [job] = yield* jobsFor(repository, webhook.id);
      assert.equal(job?.status, "failed");
      assert.equal(job?.failure, "network");
      assert.equal(job?.attempts, Delivery.MAX_OUTGOING_WEBHOOK_ATTEMPTS);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("sends a job a previous process left mid-send", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* completeOneThread(harness);
      // The process died after claiming the job and before recording an outcome.
      const claimed = yield* repository.claimDue({
        nowMs: Number.MAX_SAFE_INTEGER,
        now: "2026-10-01T12:00:00.000Z",
        limit: 10,
      });
      assert.lengthOf(claimed, 1);
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 0);

      yield* repository.requeueInterrupted("2026-10-01T12:00:01.000Z");
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);
      assert.equal((yield* jobsFor(repository, webhook.id))[0]?.status, "succeeded");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a destination that has not answered does not block the thread's next turn", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness({ gate });
    return Effect.gen(function* () {
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook, sink, thread } = yield* completeOneThread(harness);
      const sending = yield* Effect.forkChild(delivery.drain);
      yield* Deferred.await(harness.requestStarted);
      assert.equal((yield* jobsFor(repository, webhook.id))[0]?.status, "sending");

      // The first delivery is still waiting on the destination, and the next turn commits and queues anyway.
      yield* sink.write({
        events: [runUpdated(thread.id, 2, "running"), runUpdated(thread.id, 2, "completed")],
      });
      const queued = yield* jobsFor(repository, webhook.id);
      assert.deepEqual(queued.map((job) => job.status).sort(), ["queued", "sending"]);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(sending);
      assert.lengthOf(harness.requests, 2);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("outgoing webhook durability", () => {
  it.effect("a failed enqueue rolls the event back, and the same write succeeds on retry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const sql = yield* SqlClient.SqlClient;
      const { webhook } = yield* service.upsert(webhookInput());
      const thread = makeThread("thread:atomic");
      yield* sink.write({ events: [threadCreated(thread), runUpdated(thread.id, 1, "running")] });

      yield* sql`
        CREATE TRIGGER fail_enqueue BEFORE INSERT ON outgoing_webhook_jobs
        BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END
      `;
      const completed = runUpdated(thread.id, 1, "completed");
      const countEvents = () =>
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM orchestration_events WHERE stream_id = ${thread.id}
        `.pipe(Effect.map((rows) => rows[0]?.n));

      const failed = yield* Effect.exit(sink.write({ events: [completed] }));
      assert.isTrue(Exit.isFailure(failed));
      // Neither the event nor a job exists, so nothing is half-committed.
      assert.equal(yield* countEvents(), 2);
      assert.lengthOf(yield* jobsFor(repository, webhook.id), 0);

      yield* sql`DROP TRIGGER fail_enqueue`;
      yield* sink.write({ events: [completed] });
      assert.equal(yield* countEvents(), 3);
      const queued = yield* jobsFor(repository, webhook.id);
      assert.deepEqual(
        queued.map((job) => job.eventType),
        ["completed"],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a completion that left the history is not sent again, but a new run is", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const sql = yield* SqlClient.SqlClient;
      const { webhook } = yield* service.upsert(webhookInput());
      const total = () =>
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM outgoing_webhook_jobs`.pipe(
          Effect.map((rows) => rows[0]?.n),
        );

      // More completions than the history shows, oldest first.
      const threads = Array.from({ length: 55 }, (_, index) => makeThread(`thread:many-${index}`));
      for (const thread of threads) {
        yield* sink.write({
          events: [
            threadCreated(thread),
            runUpdated(thread.id, 1, "running"),
            runUpdated(thread.id, 1, "completed"),
          ],
        });
        yield* TestClock.adjust("1 second");
      }
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 55);
      assert.lengthOf(yield* jobsFor(repository, webhook.id), 50);

      // The oldest thread is evaluated again, as a background update would.
      const oldest = threads[0]!;
      yield* sink.write({ events: [runUpdated(oldest.id, 1, "completed", 1)] });
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 55);
      assert.equal(yield* total(), 55);

      // Its next run is new work.
      yield* sink.write({
        events: [runUpdated(oldest.id, 2, "running"), runUpdated(oldest.id, 2, "completed")],
      });
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 56);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "forgets finished alerts after the window, and skips a completion older than it",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const service = yield* Service.OutgoingWebhookService;
        const delivery = yield* Delivery.OutgoingWebhookDelivery;
        const repository = yield* OutgoingWebhookRepository;
        const { webhook } = yield* service.upsert(webhookInput());
        // Just after the test clock's start, which is when the webhook was enabled.
        const at = (offsetMs: number) => DateTime.makeUnsafe(offsetMs);

        const old = makeThread("thread:old");
        yield* sink.write({
          events: [
            threadCreated(old),
            runUpdated(old.id, 1, "running", 0, at(1000)),
            runUpdated(old.id, 1, "completed", 0, at(2000)),
          ],
        });
        yield* delivery.drain;
        assert.lengthOf(harness.requests, 1);

        yield* TestClock.adjust(OUTGOING_WEBHOOK_ALERT_WINDOW);
        yield* TestClock.adjust("1 day");
        const now = yield* DateTime.now;
        const fresh = makeThread("thread:fresh");
        yield* sink.write({
          events: [
            threadCreated(fresh),
            runUpdated(fresh.id, 1, "running", 0, now),
            runUpdated(fresh.id, 1, "completed", 0, now),
          ],
        });
        yield* delivery.drain;
        assert.lengthOf(harness.requests, 2);
        // The old finished job is gone from the history, and so is its dedupe record.
        assert.lengthOf(yield* jobsFor(repository, webhook.id), 1);

        yield* sink.write({ events: [runUpdated(old.id, 1, "completed", 1, at(2000))] });
        yield* delivery.drain;
        assert.lengthOf(harness.requests, 2);

        yield* sink.write({
          events: [
            runUpdated(old.id, 2, "running", 0, now),
            runUpdated(old.id, 2, "completed", 0, now),
          ],
        });
        yield* delivery.drain;
        assert.lengthOf(harness.requests, 3);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("retries send the body that was queued, whatever the webhook says by then", () => {
    const harness = makeHarness({ script: (attempt) => (attempt === 1 ? 503 : 200) });
    return Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const service = yield* Service.OutgoingWebhookService;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const { webhook } = yield* service.upsert(webhookInput());
      const first = makeThread("thread:config-one", { title: "First" });
      yield* sink.write({
        events: [
          threadCreated(first),
          runUpdated(first.id, 1, "running"),
          assistantMessage(first.id, "Full message text."),
          runUpdated(first.id, 1, "completed"),
        ],
      });
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 1);

      yield* service.upsert(
        webhookInput({
          id: webhook.id,
          endpoint: undefined,
          headers: [{ name: "Authorization" }],
          template: '{"changed":"{{message.preview}}","link":"{{thread.url}}"}',
          previewLength: 4,
          clientBaseUrl: "https://elsewhere.example.test",
        }),
      );
      yield* TestClock.adjust("10 seconds");
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 2);
      assert.equal(harness.requests[1]?.body, harness.requests[0]?.body);
      assert.equal(
        harness.requests[1]?.headers["idempotency-key"],
        harness.requests[0]?.headers["idempotency-key"],
      );
      assert.deepEqual(JSON.parse(harness.requests[0]!.body), {
        title: "First",
        body: "Full message text.",
        url: "https://sora.example.test/env-test/thread%3Aconfig-one",
      });

      // A later event is queued under the edited webhook.
      const second = makeThread("thread:config-two", { title: "Second" });
      yield* sink.write({
        events: [
          threadCreated(second),
          runUpdated(second.id, 1, "running"),
          assistantMessage(second.id, "Full message text."),
          runUpdated(second.id, 1, "completed"),
        ],
      });
      yield* delivery.drain;
      assert.deepEqual(JSON.parse(harness.requests[2]!.body), {
        changed: "Ful…",
        link: "https://elsewhere.example.test/env-test/thread%3Aconfig-two",
      });
    }).pipe(Effect.provide(harness.layer));
  });
});
