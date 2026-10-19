import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBotRecords, useBotThreadShells } from "../../state/bots";
import { resolveLegacyBotSettingsIdentity } from "../bots/botSettings.logic";
import { EnvironmentId } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";
import { ALL_ENVIRONMENTS_VALUE, selectEnvironmentAxis } from "./settingsScopeAxis";

export function ProjectsSettings() {
  const { search: value, scope, selectScope } = useSettingsScope();
  const unavailable =
    scope.kind === "unavailable" ? (
      <SettingsPageContainer>
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{scope.message}</p>
          {value.machine || value.checkout ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => selectScope(selectEnvironmentAxis(value, ALL_ENVIRONMENTS_VALUE))}
            >
              <LayersIcon />
              Show all environments
            </Button>
          ) : null}
        </div>
      </SettingsPageContainer>
    ) : null;
  const selectedMembers = scope.members;
  const isBotSelection = selectedMembers.some((member) => member.isBot);
  const records = useBotRecords();
  const roots = useBotThreadShells();
  const bot = resolveLegacyBotSettingsIdentity(records, selectedMembers, roots);
  const navigate = useNavigate();
  useEffect(() => {
    if (!isBotSelection || !bot) return;
    void navigate({
      to: "/bots/settings/$environmentId/$botId",
      params: { environmentId: bot.ownerEnvironmentId, botId: bot.id },
      replace: true,
    });
  }, [isBotSelection, bot, navigate]);
  if (isBotSelection)
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {bot
            ? "Opening bot settings…"
            : "Bot settings are unavailable. Connect the owning environment and wait for the bot to load."}
        </p>
      </SettingsPageContainer>
    );
  // Keep the panel mounted so it can follow members when regrouping changes the project key.
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
          unavailable={unavailable}
        />
      ) : unavailable ? (
        unavailable
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, checkouts and actions.
        </SettingsScopeNotice>
      )}
    </div>
  );
}
