import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Delivery from "./OutgoingWebhookDelivery.ts";
import { OutgoingWebhookRepository } from "./OutgoingWebhookRepository.ts";
import * as Service from "./OutgoingWebhookService.ts";
import {
  makeHarness,
  makeThread,
  runUpdated,
  SECRET_URL,
  threadCreated,
  webhookInput,
} from "./OutgoingWebhookTestkit.ts";

const project = "project:webhooks" as ProjectId;

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => (error as { message: string }).message));

describe("OutgoingWebhookService secrets", () => {
  it.effect(
    "never returns the endpoint or header values, and keeps them when omitted on update",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* Service.OutgoingWebhookService;
        const delivery = yield* Delivery.OutgoingWebhookDelivery;
        const sink = yield* EventSink.EventSinkV2;
        const { webhook } = yield* service.upsert(webhookInput());
        assert.equal(webhook.endpointOrigin, "https://hooks.example.test");
        assert.deepEqual(webhook.headerNames, ["Authorization"]);
        const listed = JSON.stringify(yield* service.list());
        assert.notInclude(listed, "very-secret-token");
        assert.notInclude(listed, "header-secret");
        assert.lengthOf(harness.secretNames(), 2);

        // An edit from the UI leaves every secret field empty to keep what is stored.
        yield* service.upsert(
          webhookInput({
            id: webhook.id,
            name: "Renamed",
            endpoint: undefined,
            headers: [{ name: "Authorization" }],
          }),
        );
        const thread = makeThread("thread:keep");
        yield* sink.write({
          events: [
            threadCreated(thread),
            runUpdated(thread.id, 1, "running"),
            runUpdated(thread.id, 1, "completed"),
          ],
        });
        yield* delivery.drain;
        assert.equal(harness.requests[0]?.url, SECRET_URL);
        assert.equal(harness.requests[0]?.headers["authorization"], "Bearer header-secret-456");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("drops the stored value of a header that is removed", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(webhookInput());
      assert.lengthOf(harness.secretNames(), 2);
      yield* service.upsert(webhookInput({ id: webhook.id, endpoint: undefined, headers: [] }));
      assert.lengthOf(harness.secretNames(), 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "redeems a secretRef once, only for the project that asked, and never stores it",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* Service.OutgoingWebhookService;
        const input = (ref: string) =>
          webhookInput({
            endpoint: { secretRef: ref as never },
            headers: [
              { name: "X-Api-Key", value: { secretRef: harness.issueSecretRef("k-789") as never } },
            ],
          });

        const unattended = yield* failureOf(
          service.upsert(input(harness.issueSecretRef(SECRET_URL))),
        );
        assert.include(unattended, "agent");

        const ref = harness.issueSecretRef(SECRET_URL);
        const { webhook } = yield* service.upsert(input(ref), { secretRefProjectId: project });
        assert.equal(webhook.endpointOrigin, "https://hooks.example.test");
        assert.notInclude(JSON.stringify(webhook), "very-secret-token");
        assert.lengthOf(harness.secretNames(), 2);

        // The ref is spent: a replay cannot create a second webhook from it.
        const replay = yield* failureOf(
          service.upsert(input(ref), { secretRefProjectId: project }),
        );
        assert.include(replay, "secretRef");
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("OutgoingWebhookService URL-only endpoints", () => {
  it.effect("sends to a URL that carries its own credential, with no headers at all", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { headers: _headers, ...withoutHeaders } = webhookInput();
      const { webhook } = yield* service.upsert(withoutHeaders);
      assert.deepEqual(webhook.headerNames, []);
      assert.lengthOf(harness.secretNames(), 1);
      assert.notInclude(JSON.stringify(yield* service.list()), "very-secret-token");

      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[0]?.url, SECRET_URL);
      assert.notProperty(harness.requests[0]?.headers ?? {}, "authorization");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("puts an auth header's secretRef in that header only, not in the URL", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(
        webhookInput({
          headers: [
            { name: "X-Api-Key", value: { secretRef: harness.issueSecretRef("k-789") as never } },
          ],
        }),
        { secretRefProjectId: project },
      );
      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[0]?.url, SECRET_URL);
      assert.equal(harness.requests[0]?.headers["x-api-key"], "k-789");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps the endpoint and every stored header when an edit omits both", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(webhookInput());
      const { endpoint: _endpoint, headers: _headers, ...rest } = webhookInput();
      const renamed = yield* service.upsert({ ...rest, id: webhook.id, name: "Renamed" });
      assert.equal(renamed.webhook.name, "Renamed");
      assert.deepEqual(renamed.webhook.headerNames, ["Authorization"]);
      assert.lengthOf(harness.secretNames(), 2);

      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[0]?.url, SECRET_URL);
      assert.equal(harness.requests[0]?.headers["authorization"], "Bearer header-secret-456");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("OutgoingWebhookService endpoint visibility", () => {
  it.effect(
    "defaults new direct URLs to readable config and persists visibility across reads",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* Service.OutgoingWebhookService;
        const repository = yield* OutgoingWebhookRepository;
        const { webhook } = yield* service.upsert(
          webhookInput({ secretEndpoint: undefined, headers: undefined }),
        );
        assert.isFalse(webhook.secretEndpoint);
        assert.equal(webhook.endpointUrl, SECRET_URL);
        assert.equal((yield* repository.get(webhook.id))?.endpointUrl, SECRET_URL);
        assert.equal((yield* service.list()).webhooks[0]?.endpointUrl, SECRET_URL);
        assert.lengthOf(harness.secretNames(), 0);
        yield* service.test({ id: webhook.id });
        assert.equal(harness.requests[0]?.url, SECRET_URL);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("moves a URL in both directions without resubmission and removes stale secrets", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* service.upsert(webhookInput());
      const edit = webhookInput({
        id: webhook.id,
        endpoint: undefined,
        headers: undefined,
        secretEndpoint: undefined,
      });
      const unchanged = (yield* service.upsert(edit)).webhook;
      assert.isTrue(unchanged.secretEndpoint);
      assert.isNull(unchanged.endpointUrl);
      const revealed = (yield* service.upsert({ ...edit, secretEndpoint: false })).webhook;
      assert.equal(revealed.endpointUrl, SECRET_URL);
      assert.isFalse(revealed.secretEndpoint);
      assert.lengthOf(harness.secretNames(), 1);
      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[0]?.url, SECRET_URL);
      const kept = (yield* service.upsert(edit)).webhook;
      assert.equal(kept.endpointUrl, SECRET_URL);
      const hidden = (yield* service.upsert({ ...edit, secretEndpoint: true })).webhook;
      assert.isNull(hidden.endpointUrl);
      assert.isTrue(hidden.secretEndpoint);
      assert.notInclude(JSON.stringify(yield* service.list()), "very-secret-token");
      assert.isNull((yield* repository.get(webhook.id))?.endpointUrl);
      assert.lengthOf(harness.secretNames(), 2);
      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[1]?.url, SECRET_URL);
      assert.equal(harness.requests[1]?.headers["authorization"], "Bearer header-secret-456");
      yield* service.delete({ id: webhook.id });
      assert.lengthOf(harness.secretNames(), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "defaults private endpoint refs to secret and rejects revealing an unconsumed ref",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* Service.OutgoingWebhookService;
        const ref = harness.issueSecretRef(SECRET_URL);
        const input = webhookInput({
          endpoint: { secretRef: ref as never },
          secretEndpoint: undefined,
          headers: [],
        });
        assert.include(
          yield* failureOf(
            service.upsert({ ...input, secretEndpoint: false }, { secretRefProjectId: project }),
          ),
          "secret endpoint",
        );
        const { webhook } = yield* service.upsert(input, { secretRefProjectId: project });
        assert.isTrue(webhook.secretEndpoint);
        assert.isNull(webhook.endpointUrl);
        assert.notInclude(JSON.stringify(webhook), "very-secret-token");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("validates edits before moving the stored URL", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(webhookInput());
      yield* failureOf(
        service.upsert(
          webhookInput({
            id: webhook.id,
            endpoint: undefined,
            secretEndpoint: false,
            headers: [{ name: "X-Bad", value: { value: "bad\r\nvalue" } }],
          }),
        ),
      );
      assert.isTrue((yield* service.list()).webhooks[0]?.secretEndpoint);
      assert.lengthOf(harness.secretNames(), 2);
      yield* service.test({ id: webhook.id });
      assert.equal(harness.requests[0]?.url, SECRET_URL);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("renders both native schemes for the real thread without a web base", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const sink = yield* EventSink.EventSinkV2;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      yield* service.upsert(
        webhookInput({
          clientBaseUrl: null,
          template:
            '{"web":"{{thread.url}}","sora":"{{thread.soraUrl}}","t3":"{{thread.t3codeUrl}}"}',
        }),
      );
      const thread = makeThread("スレッド/2?#%");
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          runUpdated(thread.id, 1, "completed"),
        ],
      });
      yield* delivery.drain;
      assert.deepEqual(JSON.parse(harness.requests[0]!.body), {
        web: "",
        sora: "sora://threads/env-test/%E3%82%B9%E3%83%AC%E3%83%83%E3%83%89%2F2%3F%23%25",
        t3: "t3code://threads/env-test/%E3%82%B9%E3%83%AC%E3%83%83%E3%83%89%2F2%3F%23%25",
      });
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("OutgoingWebhookService validation", () => {
  it.effect("rejects unusable configuration before storing anything", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const message = (overrides: Parameters<typeof webhookInput>[0]) =>
        failureOf(service.upsert(webhookInput(overrides)));

      assert.include(yield* message({ template: '{"a":"{{thread.nope}}"}' }), "Unknown variable");
      assert.include(yield* message({ template: '{"a":{{thread.id}}}' }), "valid JSON");
      assert.include(yield* message({ endpoint: { value: "ftp://x" } }), "http or https");
      assert.include(yield* message({ endpoint: undefined }), "needs an endpoint");
      assert.include(yield* message({ clientBaseUrl: "not a url" }), "client URL");
      assert.include(
        yield* message({ headers: [{ name: "X-A", value: { value: "a\r\nX-B: b" } }] }),
        "invalid characters",
      );
      assert.include(
        yield* message({
          headers: [
            { name: "X-A", value: { value: "1" } },
            { name: "x-a", value: { value: "2" } },
          ],
        }),
        "twice",
      );
      assert.include(yield* message({ headers: [{ name: "X-New" }] }), "needs a value");
      assert.lengthOf((yield* service.list()).webhooks, 0);
      assert.lengthOf(harness.secretNames(), 0);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("OutgoingWebhookService lifecycle", () => {
  it.effect("turning a webhook off cancels what it had queued", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const sink = yield* EventSink.EventSinkV2;
      const { webhook } = yield* service.upsert(webhookInput());
      const thread = makeThread("thread:off");
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          runUpdated(thread.id, 1, "completed"),
        ],
      });
      assert.equal((yield* repository.history(webhook.id, 10))[0]?.status, "queued");

      yield* service.upsert(
        webhookInput({
          id: webhook.id,
          enabled: false,
          endpoint: undefined,
          headers: [{ name: "Authorization" }],
        }),
      );
      yield* delivery.drain;
      assert.lengthOf(harness.requests, 0);
      assert.equal((yield* repository.history(webhook.id, 10))[0]?.status, "cancelled");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "does not send for a completion that happened before the webhook was switched on",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const service = yield* Service.OutgoingWebhookService;
        const repository = yield* OutgoingWebhookRepository;
        const sink = yield* EventSink.EventSinkV2;
        // The fixtures' runs finish on 2100-01-01; the webhook is created in 2200.
        yield* TestClock.setTime(7_258_118_400_000);
        const { webhook } = yield* service.upsert(webhookInput());
        const thread = makeThread("thread:old");
        yield* sink.write({
          events: [
            threadCreated(thread),
            runUpdated(thread.id, 1, "running"),
            runUpdated(thread.id, 1, "completed"),
          ],
        });
        assert.lengthOf(yield* repository.history(webhook.id, 10), 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("deleting removes the webhook, its queue and its secrets; a copy is unaffected", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const repository = yield* OutgoingWebhookRepository;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const sink = yield* EventSink.EventSinkV2;
      const original = (yield* service.upsert(webhookInput())).webhook;
      // A copy is a new webhook from the same fields and its own destination secrets.
      const copy = (yield* service.upsert(
        webhookInput({ name: "Copy", endpoint: { value: "https://other.example.test/hook/xyz" } }),
      )).webhook;
      assert.notEqual(copy.id, original.id);
      assert.lengthOf(harness.secretNames(), 4);

      const thread = makeThread("thread:copy");
      yield* sink.write({
        events: [
          threadCreated(thread),
          runUpdated(thread.id, 1, "running"),
          runUpdated(thread.id, 1, "completed"),
        ],
      });
      assert.lengthOf(yield* repository.history(original.id, 10), 1);
      assert.lengthOf(yield* repository.history(copy.id, 10), 1);

      assert.deepEqual(yield* service.delete({ id: original.id }), { deleted: true });
      assert.deepEqual(yield* service.delete({ id: original.id }), { deleted: false });
      assert.lengthOf(yield* repository.history(original.id, 10), 0);
      assert.lengthOf(harness.secretNames(), 2);

      yield* delivery.drain;
      assert.deepEqual(
        harness.requests.map((request) => request.url),
        ["https://other.example.test/hook/xyz"],
      );
      assert.equal((yield* repository.history(copy.id, 10))[0]?.status, "succeeded");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("Test sends one sample attempt without retrying and records only a category", () => {
    const harness = makeHarness({ script: () => 500 });
    return Effect.gen(function* () {
      const service = yield* Service.OutgoingWebhookService;
      const { webhook } = yield* service.upsert(
        webhookInput({
          enabled: false,
          template: '{"title":"{{event.emoji}} {{thread.title}}","event":"{{event.type}}"}',
        }),
      );
      const { delivery } = yield* service.test({ id: webhook.id });
      assert.equal(delivery.eventType, "test");
      assert.equal(delivery.status, "failed");
      assert.equal(delivery.failure, "server_error");
      assert.equal(delivery.httpStatus, 500);
      assert.lengthOf(harness.requests, 1);
      assert.deepEqual(JSON.parse(harness.requests[0]!.body), {
        title: "🧪 Fix the login redirect",
        event: "test",
      });
      assert.notInclude(
        JSON.stringify(yield* service.listDeliveries({ webhookId: webhook.id })),
        "very-secret",
      );
    }).pipe(Effect.provide(harness.layer));
  });
});
