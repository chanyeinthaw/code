import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  TextGenerationError,
  BotId,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as MemoryCompaction from "./MemoryCompaction.ts";

const makeInstance = (
  instanceId: ProviderInstanceId,
  generate: NonNullable<ProviderInstance["textGeneration"]["generateMemorySummary"]>,
  driverKind = "pi",
) =>
  Effect.gen(function* () {
    const adapter = yield* ProviderAdapter.ProviderAdapterV2;
    return {
      instanceId,
      driverKind: ProviderDriverKind.make(driverKind),
      continuationIdentity: {
        driverKind: ProviderDriverKind.make(driverKind),
        continuationKey: "test",
      },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () => Effect.die("Unused"),
        getSnapshot: Effect.die("Unused"),
        refresh: Effect.die("Unused"),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      orchestrationAdapter: adapter,
      textGeneration: {
        generateCommitMessage: () => Effect.die("Unused"),
        generatePrContent: () => Effect.die("Unused"),
        generateBranchName: () => Effect.die("Unused"),
        generateThreadTitle: () => Effect.die("Unused"),
        generateReviewGuide: () => Effect.die("Unused"),
        generateMemorySummary: generate,
      },
    } satisfies ProviderInstance;
  });

it.effect.each(["pi", "codex", "claudeAgent", "grok", "opencode"] as const)(
  "enforces the bot provider policy for %s compaction",
  (driverKind) =>
    Effect.gen(function* () {
      let calls = 0;
      const instanceId = ProviderInstanceId.make("compaction-test");
      const instance = yield* makeInstance(
        instanceId,
        (input) =>
          Effect.sync(() => {
            calls++;
            assert.equal(input.modelSelection.instanceId, instanceId);
            assert.equal(input.context, "Frozen context");
            assert.include(input.instructions, "Call no tools.");
            return "Summary";
          }),
        driverKind,
      );
      const compaction = yield* MemoryCompaction.MemoryCompaction.pipe(
        Effect.provide(
          MemoryCompaction.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                  getInstance: () => Effect.succeed(instance),
                }),
                Layer.mock(Settings.ServerSettingsService)({
                  getSettings: Effect.succeed({
                    ...DEFAULT_SERVER_SETTINGS,
                    memoryCompactionModelSelection: { instanceId, model: "test" },
                  }),
                }),
              ),
            ),
          ),
        ),
      );
      const result = yield* Effect.gen(function* () {
        const session = yield* compaction.open(BotId.make("test"), "Frozen context");
        return yield* session.send("Summarize");
      }).pipe(Effect.result);
      const supported = ["pi", "codex", "claudeAgent"].includes(driverKind);
      assert.equal(result._tag, supported ? "Success" : "Failure");
      assert.equal(calls, supported ? 1 : 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderAdapter.ProviderAdapterV2)({
            instanceId: ProviderInstanceId.make("compaction-test"),
            driver: ProviderDriverKind.make(driverKind),
          }),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-compaction-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.scoped,
    ),
);

const testSettings = (instanceId: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const current = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        memoryCompactionModelSelection: {
          instanceId: ProviderInstanceId.make(instanceId),
          model: "test",
        },
      });
      return Layer.mock(Settings.ServerSettingsService)({
        getSettings: Ref.get(current),
        updateSettings: (patch) =>
          Ref.updateAndGet(current, (value) => applyServerSettingsPatch(value, patch)),
      });
    }),
  );

const testDependencies = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-memory-compaction-limits-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.mock(ProviderAdapter.ProviderAdapterV2)({
      instanceId: ProviderInstanceId.make("test"),
      driver: ProviderDriverKind.make("pi"),
    }),
  ),
);

it.effect("shares the configured provider limit across memories and revisions", () =>
  Effect.gen(function* () {
    const settings = yield* Settings.ServerSettingsService;
    let active = 0;
    let peak = 0;
    const instanceId = ProviderInstanceId.make("shared");
    const instance = yield* makeInstance(instanceId, () =>
      Effect.gen(function* () {
        active++;
        peak = Math.max(peak, active);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        active--;
        return "Summary";
      }),
    );
    const compaction = yield* MemoryCompaction.MemoryCompaction.pipe(
      Effect.provide(
        MemoryCompaction.layer.pipe(
          Layer.provide(
            Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
              getInstance: () => Effect.succeed(instance),
            }),
          ),
        ),
      ),
    );
    const sessions = yield* Effect.forEach(
      Array.from({ length: 8 }, (_, index) => String(index)),
      (id) => compaction.open(BotId.make(id), "Frozen"),
    );
    for (const concurrency of [2, 8, 4] as const) {
      yield* settings.updateSettings({ memoryCompactionConcurrency: concurrency });
      peak = 0;
      yield* Effect.forEach(sessions, (session) => session.send("Summarize"), {
        concurrency: "unbounded",
      });
      assert.equal(peak, concurrency);
      assert.equal(active, 0);
    }
  }).pipe(Effect.provide(Layer.mergeAll(testSettings("shared"), testDependencies)), Effect.scoped),
);

it.effect(
  "keeps provider instances independent and releases permits on failure and interruption",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const started = yield* Deferred.make<void>();
      const first = ProviderInstanceId.make("first");
      const second = ProviderInstanceId.make("second");
      const instance = yield* makeInstance(first, ({ task }) => {
        if (task === "hold")
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        if (task === "fail")
          return Effect.fail(
            new TextGenerationError({ operation: "compact", detail: "Test generation failure" }),
          );
        return Effect.succeed("Summary");
      });
      const compaction = yield* MemoryCompaction.MemoryCompaction.pipe(
        Effect.provide(
          MemoryCompaction.layer.pipe(
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: (instanceId) => Effect.succeed({ ...instance, instanceId }),
              }),
            ),
          ),
        ),
      );
      const held = yield* compaction.open(BotId.make("held"), "Frozen");
      const fiber = yield* held.send("hold").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* settings.updateSettings({
        memoryCompactionModelSelection: { instanceId: second, model: "test" },
      });
      const independent = yield* compaction.open(BotId.make("other"), "Frozen");
      assert.equal(yield* independent.send("Summarize"), "Summary");
      yield* Fiber.interrupt(fiber);
      yield* settings.updateSettings({
        memoryCompactionModelSelection: { instanceId: first, model: "test" },
      });
      const failing = yield* compaction.open(BotId.make("failing"), "Frozen");
      assert.equal((yield* failing.send("fail").pipe(Effect.result))._tag, "Failure");
      const recovered = yield* compaction.open(BotId.make("recovered"), "Frozen");
      assert.equal(yield* recovered.send("Summarize"), "Summary");
    }).pipe(Effect.provide(Layer.mergeAll(testSettings("first"), testDependencies)), Effect.scoped),
);
