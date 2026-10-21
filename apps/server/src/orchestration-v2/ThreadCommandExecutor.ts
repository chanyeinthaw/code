import type { ThreadId } from "@satslab/contracts";
import * as KeyedLock from "@satslab/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export class ThreadCommandExecutor extends Context.Service<
  ThreadCommandExecutor,
  KeyedLock.KeyedLock<ThreadId>
>()("@satslab/sora/orchestration-v2/ThreadCommandExecutor") {}

export const layer = Layer.effect(ThreadCommandExecutor, KeyedLock.make<ThreadId>());
