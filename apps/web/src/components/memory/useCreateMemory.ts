import { RegistryContext } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { memoryChatProviderDisabledReason } from "@t3tools/shared/memoryChat";
import { useContext } from "react";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { newThreadId } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { waitForThreadShell } from "../../state/entities";
import { memoryCreate, memoryList } from "../../state/memories";
import { useAtomCommand } from "../../state/use-atom-command";

export function useCreateMemory() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const createMemory = useAtomCommand(memoryCreate);
  return async (environmentId: EnvironmentId, name: string, reuseExisting = false) => {
    const environment = environments.find((item) => item.environmentId === environmentId);
    const settings = environment?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
    const modelSelection = resolveAppModelSelectionState(
      mergeEnvironmentSettings(settings, DEFAULT_CLIENT_SETTINGS),
      (providers.get(environmentId) ?? []).filter(
        (provider) => memoryChatProviderDisabledReason(provider) === null,
      ),
    );
    const result = await createMemory({
      environmentId,
      input: {
        threadId: newThreadId(),
        name,
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        reuseExisting,
      },
    });
    if (result._tag === "Success") {
      registry.refresh(memoryList({ environmentId, input: {} }));
      // The RPC reply can arrive before the shell stream applies the new thread.
      await waitForThreadShell({ environmentId, threadId: result.value.threadId });
    }
    return result;
  };
}
