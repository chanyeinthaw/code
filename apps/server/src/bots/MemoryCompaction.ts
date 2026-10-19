import {
  BOT_CHAT_PROVIDER_DRIVERS,
  BotChatError,
  type BotId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { makeEnsureWorkspace } from "./BotWorkspace.ts";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { compactionInstructions, type MemoryInferenceSession } from "./MemoryWorker.ts";

const isBotChatError = Schema.is(BotChatError);

const make = Effect.gen(function* () {
  const ensureWorkspace = yield* makeEnsureWorkspace;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const limits = new Map<ProviderInstanceId, Semaphore.Semaphore>();
  const open = Effect.fn("MemoryCompaction.open")(
    function* (botId: BotId, context: string) {
      const current = yield* settings.getSettings;
      const modelSelection =
        current.memoryCompactionModelSelection ?? current.textGenerationModelSelection;
      const instance = yield* providers.getInstance(modelSelection.instanceId);
      const generate = instance?.textGeneration.generateMemorySummary;
      if (!generate || !BOT_CHAT_PROVIDER_DRIVERS.has(instance.driverKind))
        return yield* new BotChatError({
          operation: "compaction-provider",
          reason: "inference",
        });
      const cwd = yield* ensureWorkspace(botId);
      const original = yield* Ref.make<string | undefined>(undefined);
      return {
        send: Effect.fn("MemoryCompaction.send")(function* (task: string) {
          const first = yield* Ref.modify(original, (value) => [value ?? task, value ?? task]);
          const latest = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new BotChatError({
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
              (cause) => new BotChatError({ operation: "compact", reason: "inference", cause }),
            ),
          );
        }),
      } satisfies MemoryInferenceSession;
    },
    (effect) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isBotChatError(cause)
            ? cause
            : new BotChatError({ operation: "compaction-settings", reason: "inference", cause }),
        ),
      ),
  );
  return { open };
});
export class MemoryCompaction extends Context.Service<
  MemoryCompaction,
  Effect.Success<typeof make>
>()("t3/bots/MemoryCompaction") {}
export const layer = Layer.effect(MemoryCompaction, make);
