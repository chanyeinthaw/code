import { useAtomValue } from "@effect/atom-react";
import { BotId, selectBotIdentities, WS_METHODS, type ScopedThreadRef } from "@satslab/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@satslab/client-runtime/state/runtime";
import { arrayElementsEqual } from "@satslab/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@satslab/client-runtime/state/shell";
import { environmentThreadShells } from "./threads";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveBotThreadContext } from "../botThreadContext";
import { useQuietThreadShell } from "./entities";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { connectionAtomRuntime } from "../connection/runtime";
import { useConnectedEnvironmentIds } from "./environments";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
export const botList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bots:list",
  tag: WS_METHODS.botsList,
  staleTimeMs: 1000,
  refreshIntervalMs: 30000,
});
export const botCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:create",
  tag: WS_METHODS.botsCreate,
});
export const botRename = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:rename",
  tag: WS_METHODS.botsRename,
});
export const botReset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:reset",
  tag: WS_METHODS.botsReset,
});
export const botDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:delete",
  tag: WS_METHODS.botsDelete,
});
const lists = environmentAtomList("bots:environments", (environmentId) =>
  botList({ environmentId, input: {} }),
);
export function useBotRecords() {
  const ids = useConnectedEnvironmentIds();
  const results = useAtomValue(lists(environmentIdsKey(ids)));
  return results.flatMap((result, index) =>
    Option.getOrElse(AsyncResult.value(result), () => []).flatMap((bot) => {
      const environmentId = ids[index];
      return environmentId === undefined ? [] : [{ bot, environmentId }];
    }),
  );
}
export function useBots() {
  const records = useBotRecords();
  return selectBotIdentities(records.map((record) => record.bot)).filter(
    (bot) => bot.status !== "deleted",
  );
}
export const botTransferBegin = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferBegin",
  tag: WS_METHODS.botsTransferBegin,
});
export const botTransferRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferRead",
  tag: WS_METHODS.botsTransferRead,
});
export const botTransferWrite = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferWrite",
  tag: WS_METHODS.botsTransferWrite,
});
export const botTransferStage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferStage",
  tag: WS_METHODS.botsTransferStage,
});
export const botTransferRelease = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferRelease",
  tag: WS_METHODS.botsTransferRelease,
});
export const botTransferActivate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferActivate",
  tag: WS_METHODS.botsTransferActivate,
});
export const botTransferCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:transferCancel",
  tag: WS_METHODS.botsTransferCancel,
});

const lastBotIdSchema = Schema.NullOr(BotId);

export function useLastBotId() {
  return useLocalStorage("last-bot-id", null, lastBotIdSchema);
}

export function useLastActiveBot() {
  const bots = useBots();
  const [lastBotId] = useLastBotId();
  return (
    bots.find((bot) => bot.status === "active" && (lastBotId === null || bot.id === lastBotId)) ??
    null
  );
}

export function useBotThreadContext(ref: ScopedThreadRef | null) {
  const thread = useQuietThreadShell(ref);
  const root = useQuietThreadShell(
    ref && thread && thread.lineage.rootThreadId !== thread.id
      ? { environmentId: ref.environmentId, threadId: thread.lineage.rootThreadId }
      : null,
  );
  return resolveBotThreadContext(thread, root);
}

export function useBotAwareThreadRoute(ref: ScopedThreadRef | null) {
  const bot = useBotThreadContext(ref);
  return bot ? "/bots/$environmentId/$threadId" : "/$environmentId/$threadId";
}

const botShells = environmentAtomList("bots:thread-shells", (environmentId) => {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap(
      (thread) => {
        if (thread.botId === undefined) return [];
        const shell = get(
          environmentThreadShells.quietThreadShellAtom({ environmentId, threadId: thread.id }),
        );
        return shell ? [shell] : [];
      },
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  });
});

const emptyBotShells = Atom.make<ReadonlyArray<ReadonlyArray<EnvironmentThreadShell>>>([]);

export function useBotThreadShells(enabled = true) {
  const ids = useConnectedEnvironmentIds();
  return useAtomValue(enabled ? botShells(environmentIdsKey(ids)) : emptyBotShells).flat();
}
