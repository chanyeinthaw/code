import {
  ArrowRightLeftIcon,
  ArrowUpRightIcon,
  BotIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { Link, useRouter } from "@tanstack/react-router";
import { resolveEnvironmentMachineKind, type BotIdentity } from "@t3tools/contracts";
import { useBots } from "../../state/bots";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { MemoryCompactionSettings } from "./MemoryCompactionSettings";
import { NewBotButton } from "./NewBotButton";
import { BotActionsProvider, useBotActions, useBotMenuDisabled } from "./BotActions";

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
                  <BotRowMenu bot={bot} />
                </div>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BotRowMenu({ bot }: { bot: BotIdentity }) {
  const router = useRouter();
  const actions = useBotActions();
  const unavailable = useBotMenuDisabled(bot);
  const disabled = unavailable || actions.busy !== null;
  const paused = actions.paused(bot);
  const openSettings = () => {
    void router.navigate({
      to: "/bots/settings/$environmentId/$botId",
      params: { environmentId: bot.ownerEnvironmentId, botId: bot.id },
      state: { botSettingsReturnHref: router.state.location.href },
    });
  };
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={`${bot.name} actions`} />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={openSettings}>
          <SettingsIcon />
          Bot settings
        </MenuItem>
        <MenuSeparator />
        <MenuItem disabled={disabled} onClick={() => actions.open(bot, "rename")}>
          <PencilIcon />
          Rename…
        </MenuItem>
        {paused ? (
          <>
            <MenuItem disabled={actions.busy !== null} onClick={() => actions.resume(bot)}>
              Resume transfer
            </MenuItem>
            {paused.bot.status === "transferring" ? (
              <MenuItem disabled={actions.busy !== null} onClick={() => actions.cancel(bot)}>
                Cancel transfer
              </MenuItem>
            ) : null}
          </>
        ) : null}
        {actions.canMove(bot) ? (
          <MenuItem disabled={disabled} onClick={() => actions.open(bot, "move")}>
            <ArrowRightLeftIcon />
            Transfer to another environment…
          </MenuItem>
        ) : null}
        <MenuItem disabled={disabled} onClick={() => actions.open(bot, "reset")}>
          <RotateCcwIcon />
          Reset memory…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={disabled}
          onClick={() => actions.open(bot, "delete")}
        >
          <Trash2Icon />
          Delete bot…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
