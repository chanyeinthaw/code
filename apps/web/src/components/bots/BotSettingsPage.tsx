import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { EnvironmentId, ThreadId } from "@satslab/contracts";
import { useBotRecords, useBotThreadContext } from "../../state/bots";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { isElectron } from "../../env";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { ProjectIdentitySettings } from "../settings/ProjectIdentitySettings";
import { ProjectDefaultsSettings } from "../settings/ProjectDefaultsSettings";
import { ProjectActionsSettings } from "../settings/ProjectActionsSettings";
import { BotResourceSettings } from "./BotResourceSettings";
import { BotActionsProvider, useBotActions } from "./BotActions";
import { BotSettingsActions } from "./BotSettingsActions";
import {
  botSettingsReturnHref,
  parseBotSettingsReturnThread,
  resolveBotSettingsGroup,
  resolveBotSettingsIdentity,
} from "./botSettings.logic";

declare module "@tanstack/react-router" {
  interface HistoryState {
    botSettingsReturnHref?: string;
  }
}

export function BotSettingsPage({
  environmentId,
  botId,
}: {
  environmentId: string;
  botId: string;
}) {
  const records = useBotRecords();
  const { bot, redirectEnvironmentId } = resolveBotSettingsIdentity(records, botId, environmentId);
  const root = useQuietThreadShell(
    bot ? { environmentId: bot.ownerEnvironmentId, threadId: bot.threadId } : null,
  );
  const projects = useProjects({ includeBot: true });
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === bot?.ownerEnvironmentId && candidate.id === root?.projectId,
  );
  const projectKey = project ? deriveLogicalProjectKeyFromSettings(project, grouping) : undefined;
  const groups = useSettingsProjectGroups(projectKey);
  const group = resolveBotSettingsGroup(groups, bot, root);
  const { environments } = useEnvironments();
  const connected = environments.some(
    (environment) =>
      environment.environmentId === bot?.ownerEnvironmentId &&
      environment.connection.phase === "connected",
  );
  const navigate = useNavigate();
  const location = useLocation();
  const origin = location.state.botSettingsReturnHref;
  const returnThread = parseBotSettingsReturnThread(origin);
  const returnContext = useBotThreadContext(
    returnThread
      ? {
          environmentId: EnvironmentId.make(returnThread.environmentId),
          threadId: ThreadId.make(returnThread.threadId),
        }
      : null,
  );
  const goBack = () => {
    void navigate({ href: botSettingsReturnHref(bot, origin, returnContext) });
  };
  useEscapeToGoBack(goBack);
  useEffect(() => {
    if (!redirectEnvironmentId) return;
    void navigate({
      to: "/bots/settings/$environmentId/$botId",
      params: { environmentId: redirectEnvironmentId, botId },
      hash: location.hash,
      state: location.state,
      replace: true,
    });
  }, [redirectEnvironmentId, botId, navigate, location.hash, location.state]);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <Button size="icon-sm" variant="ghost" aria-label="Back" onClick={goBack}>
            <ArrowLeftIcon />
          </Button>
          <WorkspaceBreadcrumb ariaLabel="Bot settings breadcrumb">
            <WorkspaceBreadcrumbItem>{bot?.name ?? "Bot"}</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current>Settings</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {bot && bot.status !== "deleted" && !redirectEnvironmentId ? (
          <BotActionsProvider settingsBotId={bot.id}>
            {group && connected ? (
              <SettingsScopeProvider
                search={{
                  project: group.projectKey,
                  machine: bot.ownerEnvironmentId,
                  checkout: group.memberProjects[0]!.physicalProjectKey,
                }}
                onChange={() => undefined}
              >
                <BotSettingsPanel key={`${bot.id}:${bot.status}`} bot={bot} group={group} />
              </SettingsScopeProvider>
            ) : (
              <SettingsPageContainer showScopeSentence={false}>
                <p className="text-sm text-muted-foreground">
                  Bot settings are unavailable. Connect the owning environment and wait for the bot
                  to load.
                </p>
                <SettingsSection title="Danger">
                  <BotSettingsActions bot={bot} />
                </SettingsSection>
              </SettingsPageContainer>
            )}
          </BotActionsProvider>
        ) : (
          <SettingsPageContainer showScopeSentence={false}>
            <p className="text-sm text-muted-foreground">
              {bot?.status === "deleted"
                ? "This bot has been deleted."
                : "Bot settings are unavailable. Connect the owning environment and wait for the bot to load."}
            </p>
          </SettingsPageContainer>
        )}
      </div>
    </SidebarInset>
  );
}

function BotSettingsPanel({
  bot,
  group,
}: {
  bot: NonNullable<ReturnType<typeof resolveBotSettingsIdentity>["bot"]>;
  group: NonNullable<ReturnType<typeof resolveBotSettingsGroup>>;
}) {
  const actions = useBotActions();
  const disabled = bot.status !== "active" || actions.busy !== null;
  return (
    <SettingsPageContainer className="gap-6" showScopeSentence={false}>
      <fieldset key={disabled ? "read-only" : "editable"} disabled={disabled} className="contents">
        <ProjectIdentitySettings group={group} disabled={disabled} />
        <ProjectDefaultsSettings category="project" />
        <BotResourceSettings />
        <ProjectActionsSettings />
      </fieldset>
      <SettingsSection title="Danger">
        <BotSettingsActions bot={bot} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
