import { RegistryContext } from "@effect/atom-react";
import { selectBotIdentities } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { botList, useLastActiveBot, useLastBotId } from "../../state/bots";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useCreateBot } from "./useCreateBot";

export function BotChatPage() {
  const { manage } = useSearch({ from: "/_chat/bots" });
  const lastActiveBot = useLastActiveBot();
  const [lastBotId] = useLastBotId();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const createBot = useCreateBot();
  const primary = environments.find((item) => item.environmentId === primaryEnvironmentId);
  const environmentId =
    lastActiveBot?.ownerEnvironmentId ??
    (primary?.connection.phase === "connected" && primary.serverConfig
      ? primaryEnvironmentId
      : null);
  const open = useEffectEvent(async (signal: AbortSignal) => {
    if (manage) {
      await navigate({ to: "/settings/bots", replace: true });
      return;
    }
    if (lastActiveBot) {
      await navigate({
        to: "/bots/$environmentId/$threadId",
        params: {
          environmentId: lastActiveBot.ownerEnvironmentId,
          threadId: lastActiveBot.threadId,
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
            botList({ environmentId: item.environmentId, input: {} }),
            { suspendOnWaiting: true },
          ),
        { concurrency: "unbounded" },
      ),
      { signal },
    );
    if (signal.aborted) return;
    const available = selectBotIdentities(lists.flat()).filter((bot) => bot.status === "active");
    let bot = available.find((item) => item.id === lastBotId) ?? available[0];
    if (!bot && lists.every((list) => list.length === 0)) {
      const created = await createBot(environmentId, undefined, true);
      if (created._tag === "Success") bot = created.value;
    }
    if (signal.aborted) return;
    if (bot)
      await navigate({
        to: "/bots/$environmentId/$threadId",
        params: { environmentId: bot.ownerEnvironmentId, threadId: bot.threadId },
        replace: true,
      });
    else if (lists.some((list) => list.length > 0))
      await navigate({ to: "/settings/bots", replace: true });
  });
  useEffect(() => {
    if (!manage && environmentId === null) return;
    const controller = new AbortController();
    void open(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        toastManager.add(stackedThreadToast({ type: "error", title: "Could not open bot" }));
    });
    return () => controller.abort();
  }, [environmentId, manage]);
  return null;
}
