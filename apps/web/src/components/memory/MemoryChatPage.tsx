import { RegistryContext } from "@effect/atom-react";
import { selectMemoryIdentities } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { memoryList, useLastActiveMemory, useLastMemoryId } from "../../state/memories";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useCreateMemory } from "./useCreateMemory";

export function MemoryChatPage() {
  const { manage } = useSearch({ from: "/_chat/memory" });
  const lastActiveMemory = useLastActiveMemory();
  const [lastMemoryId] = useLastMemoryId();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const createMemory = useCreateMemory();
  const primary = environments.find((item) => item.environmentId === primaryEnvironmentId);
  const environmentId =
    lastActiveMemory?.ownerEnvironmentId ??
    (primary?.connection.phase === "connected" && primary.serverConfig
      ? primaryEnvironmentId
      : null);
  const open = useEffectEvent(async (signal: AbortSignal) => {
    if (manage) {
      await navigate({ to: "/settings/memory", replace: true });
      return;
    }
    if (lastActiveMemory) {
      await navigate({
        to: "/memory/$environmentId/$threadId",
        params: {
          environmentId: lastActiveMemory.ownerEnvironmentId,
          threadId: lastActiveMemory.threadId,
        },
        replace: true,
      });
      return;
    }
    if (environmentId === null) return;
    const lists = await Effect.runPromise(
      Effect.forEach(
        environments.filter((item) => item.connection.phase === "connected"),
        (item) =>
          AtomRegistry.getResult(
            registry,
            memoryList({ environmentId: item.environmentId, input: {} }),
            { suspendOnWaiting: true },
          ),
        { concurrency: "unbounded" },
      ),
      { signal },
    );
    if (signal.aborted) return;
    const available = selectMemoryIdentities(lists.flat()).filter(
      (memory) => memory.status === "active",
    );
    let memory = available.find((item) => item.id === lastMemoryId) ?? available[0];
    if (!memory && lists.every((list) => list.length === 0)) {
      const created = await createMemory(environmentId, "Memory", true);
      if (created._tag === "Success") memory = created.value;
    }
    if (signal.aborted) return;
    if (memory)
      await navigate({
        to: "/memory/$environmentId/$threadId",
        params: { environmentId: memory.ownerEnvironmentId, threadId: memory.threadId },
        replace: true,
      });
    else if (lists.some((list) => list.length > 0))
      await navigate({ to: "/settings/memory", replace: true });
  });
  useEffect(() => {
    if (!manage && environmentId === null) return;
    const controller = new AbortController();
    void open(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        toastManager.add(stackedThreadToast({ type: "error", title: "Could not open memory" }));
    });
    return () => controller.abort();
  }, [environmentId, manage]);
  return null;
}
