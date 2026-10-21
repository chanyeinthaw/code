import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@satslab/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@satslab/contracts/settings";
import { botChatProviderDisabledReason } from "@satslab/shared/botChat";
import { useContext } from "react";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { waitForThreadShell } from "../../state/entities";
import { botCreate, botList } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";

export function useCreateBot() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const createBot = useAtomCommand(botCreate);
  return async (environmentId: EnvironmentId, name?: string, reuseExisting = false) => {
    const environment = environments.find((item) => item.environmentId === environmentId);
    const settings = environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
    const modelSelection = resolveAppModelSelectionState(
      mergeEnvironmentSettings(settings, DEFAULT_CLIENT_SETTINGS),
      (providers.get(environmentId) ?? []).filter(
        (provider) => botChatProviderDisabledReason(provider) === null,
      ),
    );
    const result = await createBot({
      environmentId,
      input: {
        threadId: newThreadId(),
        ...(name?.trim() ? { name: name.trim() } : {}),
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        reuseExisting,
      },
    });
    if (result._tag === "Success") {
      registry.refresh(botList({ environmentId, input: {} }));
      // The RPC reply can arrive before the shell stream applies the new thread.
      await waitForThreadShell({ environmentId, threadId: result.value.threadId });
    }
    return result;
  };
}
