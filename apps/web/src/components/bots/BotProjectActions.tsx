import type { EnvironmentId, ProjectId } from "@satslab/contracts";
import { ArrowRightLeftIcon, RotateCcwIcon } from "lucide-react";
import { useBots, useBotThreadShells } from "../../state/bots";
import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import { BotActionsProvider, useBotActions, useBotMenuDisabled } from "./BotActions";

/**
 * The bot lifecycle rows of a bot's project settings, next to its Delete bot row. The project
 * links to its bot through the bot's root thread.
 */
export function BotProjectActions(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  return (
    <BotActionsProvider>
      <BotProjectActionRows {...props} />
    </BotActionsProvider>
  );
}

function BotProjectActionRows({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const actions = useBotActions();
  const botId = useBotThreadShells().find(
    (thread) => thread.environmentId === environmentId && thread.projectId === projectId,
  )?.botId;
  const bot = useBots().find((candidate) => candidate.id === botId);
  const unavailable = useBotMenuDisabled({
    ownerEnvironmentId: bot?.ownerEnvironmentId ?? environmentId,
    status: bot?.status ?? "deleted",
  });
  if (!bot) return null;
  const disabled = unavailable || actions.busy !== null;
  return (
    <>
      {actions.canMove(bot) ? (
        <SettingsRow
          title="Transfer to another environment"
          description="Moves the bot, its memory, and its conversations to another connected environment."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => actions.open(bot, "move")}
            >
              <ArrowRightLeftIcon />
              Transfer…
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title="Reset memory"
        description="Clears the bot's memory and starts a fresh conversation."
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={disabled}
            onClick={() => actions.open(bot, "reset")}
          >
            <RotateCcwIcon />
            Reset memory…
          </Button>
        }
      />
    </>
  );
}
