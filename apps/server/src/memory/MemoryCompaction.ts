import { MemoryChatError, type MemoryId, type ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { makeEnsureWorkspace } from "./MemoryWorkspace.ts";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { compactionInstructions, type MemoryInferenceSession } from "./MemoryWorker.ts";

const isMemoryChatError = Schema.is(MemoryChatError);

const make = Effect.gen(function* () {
  const ensureWorkspace = yield* makeEnsureWorkspace;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const limits = new Map<ProviderInstanceId, Semaphore.Semaphore>();
  const open = Effect.fn("MemoryCompaction.open")(
    function* (memoryId: MemoryId, context: string) {
      const current = yield* settings.getSettings;
      const modelSelection =
        current.memoryCompactionModelSelection ?? current.textGenerationModelSelection;
      const instance = yield* providers.getInstance(modelSelection.instanceId);
      const generate = instance?.textGeneration.generateMemorySummary;
      if (!generate)
        return yield* new MemoryChatError({
          operation: "compaction-provider",
          reason: "inference",
        });
      const cwd = yield* ensureWorkspace(memoryId);
      const original = yield* Ref.make<string | undefined>(undefined);
      return {
        send: Effect.fn("MemoryCompaction.send")(function* (task: string) {
          const first = yield* Ref.modify(original, (value) => [value ?? task, value ?? task]);
          const latest = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new MemoryChatError({
                  operation: "compaction-settings",
                  reason: "inference",
                  cause,
                }),
            ),
          );
          let limit = limits.get(modelSelection.instanceId);
          if (!limit) {
            limit = Semaphore.makeUnsafe(latest.memoryCompactionConcurrency);
            limits.set(modelSelection.instanceId, limit);
          }
          yield* limit.resize(latest.memoryCompactionConcurrency);
          return yield* generate({
            cwd,
            instructions: compactionInstructions,
            context,
            task: first === task ? task : `${first}\n\nRevision request:\n${task}`,
            modelSelection,
          }).pipe(
            limit.withPermit,
            Effect.mapError(
              (cause) => new MemoryChatError({ operation: "compact", reason: "inference", cause }),
            ),
          );
        }),
      } satisfies MemoryInferenceSession;
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isMemoryChatError(cause)
            ? cause
            : new MemoryChatError({ operation: "compaction-settings", reason: "inference", cause }),
        ),
      ),
  );
  return { open };
});
export class MemoryCompaction extends Context.Service<
  MemoryCompaction,
  Effect.Success<typeof make>
>()("t3/memory/MemoryCompaction") {}
export const layer = Layer.effect(MemoryCompaction, make);
