import type { BotIdentity } from "@satslab/contracts";
import { ArrowRightLeftIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { SettingsRow } from "../settings/settingsLayout";
import { useBotActions, useBotMenuDisabled } from "./BotActions";

export function BotSettingsActions({ bot }: { bot: BotIdentity }) {
  const actions = useBotActions();
  const unavailable = useBotMenuDisabled({
    ownerEnvironmentId: bot.ownerEnvironmentId,
    status: bot.status,
  });
  const disabled = unavailable || actions.busy !== null;
  return (
    <>
      {actions.paused(bot) ? (
        <SettingsRow
          title="Move paused"
          control={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actions.busy !== null}
                onClick={() => actions.resume(bot)}
              >
                Resume transfer
              </Button>
              {actions.paused(bot)?.bot.status === "transferring" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actions.busy !== null}
                  onClick={() => actions.cancel(bot)}
                >
                  Cancel transfer
                </Button>
              ) : null}
            </div>
          }
        />
      ) : null}
      {actions.canMove(bot) ? (
        <SettingsRow
          title="Transfer to another environment"
          description="Moves the bot, its conversation, memory, and settings to another connected environment."
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
      <SettingsRow
        title="Delete bot"
        description="Deletes the bot, its memory, conversations, and project entry. Files on disk are not touched."
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={disabled}
            onClick={() => actions.open(bot, "delete")}
          >
            <Trash2Icon />
            Delete bot
          </Button>
        }
      />
    </>
  );
}
