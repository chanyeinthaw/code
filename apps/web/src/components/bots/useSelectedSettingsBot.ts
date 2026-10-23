import { useBotRecords, useBotThreadShells } from "../../state/bots";
import { useEnvironments } from "../../state/environments";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { resolveSettingsScope, type SettingsScopeSearch } from "../settings/settingsScope";
import { resolveLegacyBotSettingsIdentity } from "./botSettings.logic";

export function useSelectedSettingsBot(search: SettingsScopeSearch) {
  const groups = useSettingsProjectGroups(search.project);
  const { environments } = useEnvironments();
  const records = useBotRecords();
  const roots = useBotThreadShells(search.project !== undefined);
  const scope = resolveSettingsScope(search, groups, environments);
  return resolveLegacyBotSettingsIdentity(records, scope.members, roots);
}
