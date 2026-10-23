import { assert, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A throwaway local fixture server; no Effect equivalent is needed for this.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Delivery from "./OutgoingWebhookDelivery.ts";
import { OutgoingWebhookRepository } from "./OutgoingWebhookRepository.ts";
import * as Service from "./OutgoingWebhookService.ts";
import {
  makeHarness,
  makeThread,
  runUpdated,
  threadCreated,
  webhookInput,
} from "./OutgoingWebhookTestkit.ts";

interface Seen {
  readonly path: string;
  readonly method: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

interface Fixture {
  readonly origin: string;
  readonly seen: Array<Seen>;
  readonly server: NodeHttp.Server;
}

/** A loopback fixture; nothing leaves this machine. */
const fixtureServer = Effect.acquireRelease(
  Effect.callback<Fixture>((resume) => {
    const seen: Array<Seen> = [];
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          path: request.url ?? "",
          method: request.method ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (request.url === "/redirect") {
          response.writeHead(307, { location: "/followed" });
        } else {
          response.writeHead(200);
        }
        response.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, seen, server }));
    });
  }),
  ({ server }) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

const completeThread = (name: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const thread = makeThread(name);
    yield* sink.write({
      events: [
        threadCreated(thread),
        runUpdated(thread.id, 1, "running"),
        runUpdated(thread.id, 1, "completed"),
      ],
    });
  });

it.live("posts the rendered JSON with its headers over real HTTP", () => {
  const harness = makeHarness({ http: FetchHttpClient.layer });
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* fixtureServer;
      const service = yield* Service.OutgoingWebhookService;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* service.upsert(
        webhookInput({ endpoint: { value: `${fixture.origin}/hook/secret-token` } }),
      );
      yield* completeThread("thread:wire");
      yield* delivery.drain;

      assert.lengthOf(fixture.seen, 1);
      const request = fixture.seen[0]!;
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/hook/secret-token");
      assert.equal(request.headers["content-type"], "application/json");
      assert.equal(request.headers["authorization"], "Bearer header-secret-456");
      assert.equal(
        request.headers["idempotency-key"],
        (yield* repository.history(webhook.id, 1))[0]?.id,
      );
      assert.equal(JSON.parse(request.body).title, "thread:wire");
    }).pipe(Effect.provide(harness.layer)),
  );
});

it.live("does not follow a redirect, so configured headers never reach another address", () => {
  const harness = makeHarness({ http: FetchHttpClient.layer });
  return Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* fixtureServer;
      const service = yield* Service.OutgoingWebhookService;
      const delivery = yield* Delivery.OutgoingWebhookDelivery;
      const repository = yield* OutgoingWebhookRepository;
      const { webhook } = yield* service.upsert(
        webhookInput({ endpoint: { value: `${fixture.origin}/redirect` } }),
      );
      yield* completeThread("thread:redirect");
      yield* delivery.drain;

      assert.deepEqual(
        fixture.seen.map((request) => request.path),
        ["/redirect"],
      );
      const [job] = yield* repository.history(webhook.id, 1);
      assert.equal(job?.status, "failed");
      assert.equal(job?.failure, "rejected");
      assert.equal(job?.httpStatus, 307);
    }).pipe(Effect.provide(harness.layer)),
  );
});
