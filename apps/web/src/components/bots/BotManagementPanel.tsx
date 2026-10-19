import { ArrowUpRightIcon, BotIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useBots } from "../../state/bots";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { MemoryCompactionSettings } from "./MemoryCompactionSettings";
import { NewBotButton } from "./NewBotButton";
import { BotActionsProvider, BotActionsMenu, useBotActions } from "./BotActions";

export function BotManagementPanel() {
  return (
    <BotActionsProvider>
      <BotManagementRows />
    </BotActionsProvider>
  );
}

function BotManagementRows() {
  const bots = useBots();
  const { environments } = useEnvironments();
  const { search } = useSettingsScope();
  const actions = useBotActions();
  const visible = bots.filter(
    (bot) => !search.machine || bot.ownerEnvironmentId === search.machine,
  );
  return (
    <SettingsPageContainer>
      <MemoryCompactionSettings />
      <SettingsSection title={`Bots (${visible.length})`} headerAction={<NewBotButton />}>
        {visible.length === 0 ? <SettingsRow title="No bots" /> : null}
        {visible.map((bot) => {
          const owner = environments.find((env) => env.environmentId === bot.ownerEnvironmentId);
          const connected = owner?.connection.phase === "connected";
          const paused = actions.paused(bot);
          return (
            <SettingsRow
              key={bot.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{bot.name}</span>
                </span>
              }
              description={
                <span className="flex flex-wrap items-center gap-1.5">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(owner?.serverConfig ?? null)}
                    className="size-3.5"
                  />
                  {owner?.label ?? bot.ownerEnvironmentId}
                  {!connected ? " · Offline" : null}
                  {paused ? (actions.busy === bot.id ? " · Moving…" : " · Move paused") : null}
                </span>
              }
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Open ${bot.name}`}
                    title="Open bot"
                    disabled={!connected || bot.status !== "active"}
                    render={
                      <Link
                        to="/bots/$environmentId/$threadId"
                        params={{
                          environmentId: bot.ownerEnvironmentId,
                          threadId: bot.threadId,
                        }}
                      />
                    }
                  >
                    <ArrowUpRightIcon />
                  </Button>
                  <BotActionsMenu bot={bot} />
                </div>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
