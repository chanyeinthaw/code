import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { SettingResetButton, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { searchableSetting } from "../settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../settings/useScopedSettings";
import { Switch } from "../ui/switch";

/** A bot project's choice of whether its replies load the provider's own instructions and skills. */
export function BotResourceSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["botLoadResources"]);
  return (
    <SettingsSection id="bot-instructions" title="Instructions">
      <SettingsRow
        serverScoped
        settingKeys={["botLoadResources"]}
        mixed={mixed}
        {...searchableSetting("bot-load-resources")}
        description="Lets replies use the provider's global and workspace instruction files (AGENTS.md, CLAUDE.md) and skills. Their effects can appear in replies and tool results saved to memory. Memory compaction never loads them. Applies from the next reply."
        resetAction={
          settings.botLoadResources !== DEFAULT_SERVER_SETTINGS.botLoadResources ? (
            <SettingResetButton
              label="bot instructions and skills"
              onClick={() =>
                updateSettings({ botLoadResources: DEFAULT_SERVER_SETTINGS.botLoadResources })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Load instructions and skills"
            mixed={mixed}
            checked={mixed ? false : settings.botLoadResources}
            onCheckedChange={(enabled) => updateSettings({ botLoadResources: enabled })}
          />
        }
      />
    </SettingsSection>
  );
}
