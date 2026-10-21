import type { ProviderInstanceId } from "@satslab/contracts";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MEMORY_COMPACTION_CONCURRENCY_OPTIONS,
} from "@satslab/contracts/settings";
import { botChatProviderDisabledReason } from "@satslab/shared/botChat";
import { createModelSelection } from "@satslab/shared/model";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { useScopedModelDisabledReason } from "../settings/useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
  selectsPlanAgent,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";

export function MemoryCompactionSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixedConcurrency = useScopedSettingsMixed(["memoryCompactionConcurrency"]);
  const { environment, connectedEnvironments, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const hasServerTargets = connectedEnvironments.length > 0;
  const providersByEnvironment = useEnvironmentProviders();
  const serverProviders =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const textGenerationProviders = serverProviders.filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(textGenerationProviders),
      settings,
      target?.projectId ?? null,
    ),
  );
  const hasTextGenerationProvider = textGenerationModelInstanceEntries.some(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const textGenerationModelDisabledReason = useScopedModelDisabledReason(
    settings,
    textGenerationModelInstanceEntries,
  );
  const memoryModelSelection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.memoryCompactionModelSelection ?? settings.textGenerationModelSelection,
    },
    textGenerationProviders,
  );
  const memoryModelDisabledReason = (instanceId: ProviderInstanceId, model: string) => {
    const reason = textGenerationModelDisabledReason(instanceId, model);
    if (reason) return reason;
    const provider = textGenerationProviders.find((item) => item.instanceId === instanceId);
    return provider ? botChatProviderDisabledReason(provider) : null;
  };
  const memoryModelEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === memoryModelSelection.instanceId,
  );
  const memoryModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    textGenerationProviders,
    memoryModelSelection.instanceId,
    memoryModelSelection.model,
  );
  return (
    <SettingsSection id="memory-compaction" title="Compaction">
      <SettingsRow
        serverScoped
        settingKeys={["memoryCompactionConcurrency"]}
        {...searchableSetting("memory-compaction-concurrency")}
        description="Maximum simultaneous compaction requests per provider instance, shared across all bots in this environment. Applies to subsequent requests."
        resetAction={
          settings.memoryCompactionConcurrency !==
          DEFAULT_UNIFIED_SETTINGS.memoryCompactionConcurrency ? (
            <SettingResetButton
              label="memory compaction concurrency"
              onClick={() =>
                updateSettings({
                  memoryCompactionConcurrency: DEFAULT_UNIFIED_SETTINGS.memoryCompactionConcurrency,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={mixedConcurrency ? null : settings.memoryCompactionConcurrency}
            onValueChange={(value) => {
              if (value !== null) updateSettings({ memoryCompactionConcurrency: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Memory compaction concurrency">
              <SelectValue placeholder="Mixed" />
            </SelectTrigger>
            <SelectPopup>
              {MEMORY_COMPACTION_CONCURRENCY_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["memoryCompactionModelSelection"]}
        {...searchableSetting("memory-compaction-model")}
        description="Choose the model that summarizes older memory messages in the background. Uses the text generation model when unset."
        resetAction={
          settings.memoryCompactionModelSelection !== null ? (
            <SettingResetButton
              label="memory compaction model"
              onClick={() => updateSettings({ memoryCompactionModelSelection: null })}
            />
          ) : null
        }
        control={
          hasServerTargets && hasTextGenerationProvider ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <ProviderModelPicker
                environmentId={environmentId}
                activeInstanceId={memoryModelSelection.instanceId}
                model={memoryModelSelection.model}
                lockedProvider={null}
                instanceEntries={textGenerationModelInstanceEntries}
                modelOptionsByInstance={memoryModelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                getModelDisabledReason={memoryModelDisabledReason}
                onInstanceModelChange={(instanceId, model) => {
                  if (!memoryModelDisabledReason(instanceId, model))
                    updateSettings({
                      memoryCompactionModelSelection: createModelSelection(instanceId, model),
                    });
                }}
              />
              {memoryModelEntry ? (
                <TraitsPicker
                  provider={memoryModelEntry.driverKind}
                  models={memoryModelEntry.models}
                  model={memoryModelSelection.model}
                  modelOptions={memoryModelSelection.options}
                  allowPromptInjectedEffort={false}
                  planModeEnabled={
                    settings.planModeEnabled || selectsPlanAgent(memoryModelSelection.options)
                  }
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    updateSettings({
                      memoryCompactionModelSelection: createModelSelection(
                        memoryModelSelection.instanceId,
                        memoryModelSelection.model,
                        options,
                      ),
                    })
                  }
                />
              ) : null}
            </div>
          ) : null
        }
      />
    </SettingsSection>
  );
}
