import { useAtomValue } from "@effect/atom-react";
import {
  MemoryId,
  selectMemoryIdentities,
  WS_METHODS,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { environmentThreadShells } from "./threads";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveMemoryThreadContext } from "../memoryThreadContext";
import { useQuietThreadShell } from "./entities";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { connectionAtomRuntime } from "../connection/runtime";
import { useConnectedEnvironmentIds } from "./environments";
import { environmentAtomList, environmentIdsKey } from "./environmentAtomList";
export const memoryList = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "memories:list",
  tag: WS_METHODS.memoriesList,
  staleTimeMs: 1000,
  refreshIntervalMs: 30000,
});
export const memoryCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:create",
  tag: WS_METHODS.memoriesCreate,
});
export const memoryReset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:reset",
  tag: WS_METHODS.memoriesReset,
});
export const memoryDelete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:delete",
  tag: WS_METHODS.memoriesDelete,
});
const lists = environmentAtomList("memories:environments", (environmentId) =>
  memoryList({ environmentId, input: {} }),
);
export function useMemoryRecords() {
  const ids = useConnectedEnvironmentIds();
  const results = useAtomValue(lists(environmentIdsKey(ids)));
  return results.flatMap((result, index) =>
    Option.getOrElse(AsyncResult.value(result), () => []).flatMap((memory) => {
      const environmentId = ids[index];
      return environmentId === undefined ? [] : [{ memory, environmentId }];
    }),
  );
}
export function useMemories() {
  const records = useMemoryRecords();
  return selectMemoryIdentities(records.map((record) => record.memory)).filter(
    (memory) => memory.status !== "deleted",
  );
}
export const memoryTransferBegin = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferBegin",
  tag: WS_METHODS.memoriesTransferBegin,
});
export const memoryTransferRead = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferRead",
  tag: WS_METHODS.memoriesTransferRead,
});
export const memoryTransferWrite = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferWrite",
  tag: WS_METHODS.memoriesTransferWrite,
});
export const memoryTransferStage = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferStage",
  tag: WS_METHODS.memoriesTransferStage,
});
export const memoryTransferRelease = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferRelease",
  tag: WS_METHODS.memoriesTransferRelease,
});
export const memoryTransferActivate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferActivate",
  tag: WS_METHODS.memoriesTransferActivate,
});
export const memoryTransferCancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "memories:transferCancel",
  tag: WS_METHODS.memoriesTransferCancel,
});

const lastMemoryIdSchema = Schema.NullOr(MemoryId);

export function useLastMemoryId() {
  return useLocalStorage("last-memory-id", null, lastMemoryIdSchema);
}

export function useLastActiveMemory() {
  const memories = useMemories();
  const [lastMemoryId] = useLastMemoryId();
  return (
    memories.find(
      (memory) =>
        memory.status === "active" && (lastMemoryId === null || memory.id === lastMemoryId),
    ) ?? null
  );
}

export function useMemoryThreadContext(ref: ScopedThreadRef | null) {
  const thread = useQuietThreadShell(ref);
  const root = useQuietThreadShell(
    ref && thread && thread.lineage.rootThreadId !== thread.id
      ? { environmentId: ref.environmentId, threadId: thread.lineage.rootThreadId }
      : null,
  );
  return resolveMemoryThreadContext(thread, root);
}

export function useMemoryAwareThreadRoute(ref: ScopedThreadRef | null) {
  const memory = useMemoryThreadContext(ref);
  return memory ? "/memory/$environmentId/$threadId" : "/$environmentId/$threadId";
}

const memoryShells = environmentAtomList("memories:thread-shells", (environmentId) => {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap(
      (thread) => {
        if (thread.memoryIdentityId === undefined) return [];
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

export function useMemoryThreadShells() {
  const ids = useConnectedEnvironmentIds();
  return useAtomValue(memoryShells(environmentIdsKey(ids))).flat();
}
