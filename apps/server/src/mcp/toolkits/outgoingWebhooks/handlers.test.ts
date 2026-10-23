import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OutgoingWebhookAgentUpsertInput,
  ProviderInstanceId,
  SecretRef,
  ThreadId,
  type AuthMcpClientAccess,
} from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OutgoingWebhookService from "../../../outgoingWebhooks/OutgoingWebhookService.ts";
import { makeHarness, SECRET_URL } from "../../../outgoingWebhooks/OutgoingWebhookTestkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { OutgoingWebhooksToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:webhooks");
const threadId = ThreadId.make("thread:webhooks");

const upsertParams = {
  name: "Hark",
  enabled: true,
  events: ["completed"],
  template: '{"body":"{{message.preview}}"}',
  previewLength: 500,
  clientBaseUrl: null,
  endpoint: { secretRef: SecretRef.make("secret-ref:00000000000000000000000000000001") },
  headers: [],
} as const;

const decodeAgentUpsert = Schema.decodeUnknownSync(OutgoingWebhookAgentUpsertInput);

/** Runs one tool as a thread caller or an external client, and reports what reached the service. */
const run = (input: {
  readonly tool: "s3_outgoing_webhooks_upsert" | "s3_outgoing_webhooks_list";
  readonly caller:
    | { readonly kind: "thread"; readonly runtimeMode?: "approval-required" | "full-access" }
    | { readonly kind: "client"; readonly access: AuthMcpClientAccess };
}) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly projectId: string | undefined }>>([]);
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:webhooks",
        thread:
          input.caller.kind === "thread"
            ? {
                threadId,
                providerSessionId: "provider:webhooks",
                providerInstanceId: ProviderInstanceId.make("codex"),
              }
            : undefined,
        client:
          input.caller.kind === "client"
            ? { sessionId: "client", label: "Client", access: input.caller.access }
            : undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(
            liveThreadShell(
              threadId,
              input.caller.kind === "thread" && input.caller.runtimeMode !== undefined
                ? { runtimeMode: input.caller.runtimeMode }
                : {},
            ),
          ),
      }),
      Layer.mock(OutgoingWebhookService.OutgoingWebhookService)({
        list: () => Effect.succeed({ webhooks: [] }),
        upsert: (_input, options) =>
          Ref.update(calls, (all) => [...all, { projectId: options?.secretRefProjectId }]).pipe(
            Effect.andThen(Effect.die("stop after recording")),
          ),
      }),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* OutgoingWebhooksToolkit;
      const collected = yield* toolkit
        .handle(input.tool, input.tool === "s3_outgoing_webhooks_list" ? {} : upsertParams)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.exit);
      return collected;
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
    return { result, calls: yield* Ref.get(calls) };
  });

it.effect("lets a full-access thread redeem its own secretRefs, inside its own project", () =>
  Effect.gen(function* () {
    const { calls } = yield* run({
      tool: "s3_outgoing_webhooks_upsert",
      caller: { kind: "thread" },
    });
    expect(calls).toEqual([{ projectId: "project:mcp-test" }]);
  }),
);

it.effect("gives an external full-access client no way to redeem a secretRef", () =>
  Effect.gen(function* () {
    const { calls } = yield* run({
      tool: "s3_outgoing_webhooks_upsert",
      caller: { kind: "client", access: "full-access" },
    });
    expect(calls).toEqual([{ projectId: undefined }]);
  }),
);

it.effect("refuses to change webhooks for a read-only client or a thread below full access", () =>
  Effect.gen(function* () {
    for (const caller of [
      { kind: "client", access: "read-only" },
      { kind: "thread", runtimeMode: "approval-required" },
    ] as const) {
      const { calls, result } = yield* run({ tool: "s3_outgoing_webhooks_upsert", caller });
      expect(calls).toEqual([]);
      expect(JSON.stringify(result)).toContain("capability_denied");
    }
    const { result } = yield* run({
      tool: "s3_outgoing_webhooks_list",
      caller: { kind: "client", access: "read-only" },
    });
    expect(JSON.stringify(result)).not.toContain("capability_denied");
  }),
);

it("accepts a direct endpoint URL or a secretRef from an agent, but header values only as secretRefs", () => {
  const { headers: _headers, ...withoutHeaders } = upsertParams;
  expect(() => decodeAgentUpsert(upsertParams)).not.toThrow();
  // A URL that already carries its credential needs no headers and no secret card.
  expect(() =>
    decodeAgentUpsert({
      ...withoutHeaders,
      endpoint: { value: "https://hooks.example.com/x?key=abc" },
    }),
  ).not.toThrow();
  expect(() =>
    decodeAgentUpsert({
      ...upsertParams,
      headers: [{ name: "X-Key", value: { secretRef: upsertParams.endpoint.secretRef } }],
    }),
  ).not.toThrow();
  expect(() =>
    decodeAgentUpsert({ ...upsertParams, headers: [{ name: "X-Key", value: { value: "plain" } }] }),
  ).toThrow();
});

/** Calls the upsert tool against the real service, as a full-access thread. */
const upsertWithRealService = (harness: ReturnType<typeof makeHarness>, params: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* OutgoingWebhooksToolkit;
    const decoded = decodeAgentUpsert(params);
    return yield* toolkit
      .handle("s3_outgoing_webhooks_upsert", decoded)
      .pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId,
              requestNamespace: "provider:webhooks",
              thread: {
                threadId,
                providerSessionId: "provider:webhooks",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId, {})),
            }),
            harness.layer,
          ),
        ),
      ),
    ),
  );

it.effect("keeps a direct URL secret when explicitly marked, without requiring headers", () => {
  const harness = makeHarness();
  const { headers: _headers, ...withoutHeaders } = upsertParams;
  return Effect.gen(function* () {
    const reply = yield* upsertWithRealService(harness, {
      ...withoutHeaders,
      endpoint: { value: SECRET_URL },
      secretEndpoint: true,
    });
    const text = JSON.stringify(reply);
    expect(text).toContain("https://hooks.example.test");
    expect(text).not.toContain("very-secret-token");
    expect(text).not.toContain("capability_denied");
    // Only the endpoint is stored; no header secret appears from the omission.
    expect(harness.secretNames()).toHaveLength(1);
  });
});

it.effect("keeps an auth header's secretRef as that header's value and not in the URL", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const ref = harness.issueSecretRef("Bearer header-secret-456");
    const reply = yield* upsertWithRealService(harness, {
      ...upsertParams,
      endpoint: { value: SECRET_URL },
      secretEndpoint: true,
      headers: [{ name: "Authorization", value: { secretRef: ref } }],
    });
    expect(JSON.stringify(reply)).toContain("Authorization");
    expect(JSON.stringify(reply)).not.toContain("header-secret");
    expect(harness.secretNames()).toHaveLength(2);
  });
});

it.effect("returns an ordinary direct URL as readable configuration by default", () => {
  const harness = makeHarness();
  const { headers: _headers, ...withoutHeaders } = upsertParams;
  return Effect.gen(function* () {
    const reply = yield* upsertWithRealService(harness, {
      ...withoutHeaders,
      endpoint: { value: "https://hooks.example.test/ordinary" },
    });
    expect(JSON.stringify(reply)).toContain("https://hooks.example.test/ordinary");
    expect(harness.secretNames()).toHaveLength(0);
  });
});
