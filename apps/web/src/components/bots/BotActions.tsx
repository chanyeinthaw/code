import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import type { EnvironmentId, BotIdentity, BotId } from "@t3tools/contracts";
import { waitForThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  useBotRecords,
  useBotThreadContext,
  useLastBotId,
  botList,
  botReset,
  botRename,
  botDelete,
  botTransferBegin,
  botTransferRead,
  botTransferWrite,
  botTransferStage,
  botTransferRelease,
  botTransferActivate,
  botTransferCancel,
} from "../../state/bots";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { BotEnvironmentSelect } from "./BotEnvironmentSelect";
import { BotActionButton } from "./BotActionButton";

type BotAction = "reset" | "delete" | "move" | "rename";
const BotActionsContext = createContext<{
  open: (bot: BotIdentity, action: BotAction) => void;
  busy: string | null;
  canMove: (bot: BotIdentity) => boolean;
  resume: (bot: BotIdentity) => void;
  cancel: (bot: BotIdentity) => void;
  paused: (bot: BotIdentity) => ReturnType<typeof useBotRecords>[number] | undefined;
} | null>(null);

export function useBotActions() {
  const context = useContext(BotActionsContext);
  if (!context) throw new Error("Bot actions require their provider.");
  return context;
}

export function BotActionsProvider({
  children,
  settingsBotId,
}: {
  children: ReactNode;
  settingsBotId?: BotId;
}) {
  const { environments } = useEnvironments();
  const registry = useContext(RegistryContext);
  const records = useBotRecords();
  const navigate = useNavigate();
  const currentBot = useBotThreadContext(useThreadRouteRef());
  const [, setLastBotId] = useLastBotId();
  const renameCommand = useAtomCommand(botRename);
  const [renameBot, setRenameBot] = useState<BotIdentity | null>(null);
  const [name, setName] = useState("");
  const renameFormId = useId();
  const resetBot = useAtomCommand(botReset);
  const deleteBot = useAtomCommand(botDelete);
  const beginTransfer = useAtomCommand(botTransferBegin);
  const readTransfer = useAtomCommand(botTransferRead);
  const writeTransfer = useAtomCommand(botTransferWrite);
  const stageTransfer = useAtomCommand(botTransferStage);
  const releaseTransfer = useAtomCommand(botTransferRelease);
  const activateTransfer = useAtomCommand(botTransferActivate);
  const cancelTransfer = useAtomCommand(botTransferCancel);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveBot, setMoveBot] = useState<BotIdentity | null>(null);
  const [moveDestinationId, setMoveDestinationId] = useState<EnvironmentId | null>(null);
  const [confirmation, setConfirmation] = useState<{
    bot: BotIdentity;
    action: "reset" | "delete";
  } | null>(null);
  const refresh = () => {
    for (const environment of environments)
      registry.refresh(botList({ environmentId: environment.environmentId, input: {} }));
  };
  const transfer = async (bot: BotIdentity, source: EnvironmentId, destination: EnvironmentId) => {
    if (moving) return;
    setMoving(bot.id);
    const move = async () => {
      const begun = await beginTransfer({
        environmentId: source,
        input: { botId: bot.id, destinationEnvironmentId: destination },
      });
      if (begun._tag !== "Success") return;
      const descriptor = begun.value;
      for (let offset = 0; offset < descriptor.length;) {
        const chunk = await readTransfer({
          environmentId: source,
          input: { botId: bot.id, transferId: descriptor.transferId, offset },
        });
        if (chunk._tag !== "Success") return;
        const written = await writeTransfer({
          environmentId: destination,
          input: { transferId: descriptor.transferId, offset, data: chunk.value.data },
        });
        if (written._tag !== "Success") return;
        offset = chunk.value.nextOffset;
      }
      const staged = await stageTransfer({
        environmentId: destination,
        input: {
          transferId: descriptor.transferId,
          length: descriptor.length,
        },
      });
      if (staged._tag !== "Success") return;
      const released = await releaseTransfer({
        environmentId: source,
        input: { botId: bot.id, transferId: descriptor.transferId },
      });
      if (released._tag !== "Success") return;
      await activateTransfer({
        environmentId: destination,
        input: {
          botId: bot.id,
          transferId: descriptor.transferId,
          secret: released.value.secret,
        },
      });
    };
    await move().finally(() => {
      refresh();
      setMoving(null);
    });
  };
  const cancel = async (bot: BotIdentity, source: EnvironmentId) => {
    const destinationEnvironmentId = bot.destinationEnvironmentId;
    if (!destinationEnvironmentId || moving) return;
    setMoving(bot.id);
    const cancelMove = async () => {
      const descriptor = await beginTransfer({
        environmentId: source,
        input: { botId: bot.id, destinationEnvironmentId },
      });
      if (descriptor._tag === "Success")
        await cancelTransfer({
          environmentId: source,
          input: { botId: bot.id, transferId: descriptor.value.transferId },
        });
    };
    await cancelMove().finally(() => {
      refresh();
      setMoving(null);
    });
  };
  const connectedEnvironments = environments.filter(
    (item) => item.connection.phase === "connected",
  );
  const moveDestinations = connectedEnvironments.filter(
    (item) => item.environmentId !== moveBot?.ownerEnvironmentId,
  );
  const moveDestination =
    moveDestinations.find((item) => item.environmentId === moveDestinationId) ??
    moveDestinations[0];
  const moveOwner = environments.find((item) => item.environmentId === moveBot?.ownerEnvironmentId);
  const canMove = (bot: BotIdentity) =>
    bot.status === "active" &&
    connectedEnvironments.some((item) => item.environmentId !== bot.ownerEnvironmentId);
  const open = (bot: BotIdentity, action: BotAction) => {
    if (moving) return;
    if (action === "rename") {
      setName(bot.name);
      setRenameBot(bot);
    } else if (action === "move") {
      setMoveDestinationId(null);
      setMoveBot(bot);
    } else setConfirmation({ bot, action });
  };
  const rename = async () => {
    const bot = renameBot;
    const title = name.trim();
    if (!bot || !title || moving) return;
    setMoving(bot.id);
    await renameCommand({
      environmentId: bot.ownerEnvironmentId,
      input: { botId: bot.id, name: title },
    })
      .then((result) => {
        if (result._tag === "Success") {
          setRenameBot(null);
          refresh();
        }
      })
      .finally(() => setMoving(null));
  };
  const confirm = async () => {
    if (!confirmation || moving) return;
    const { bot, action } = confirmation;
    const wasCurrent = currentBot?.botId === bot.id;
    setMoving(bot.id);
    const result =
      action === "reset"
        ? await resetBot({
            environmentId: bot.ownerEnvironmentId,
            input: { botId: bot.id },
          })
        : await deleteBot({
            environmentId: bot.ownerEnvironmentId,
            input: { botId: bot.id },
          });
    if (result._tag === "Success") {
      const query = botList({ environmentId: bot.ownerEnvironmentId, input: {} });
      registry.refresh(query);
      await Effect.runPromise(
        AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }),
      ).catch(() => undefined);
      setConfirmation(null);
      if (settingsBotId === bot.id) {
        if (action === "delete") {
          setLastBotId(null);
          await navigate({ to: "/settings/bots", replace: true });
        }
      } else if (wasCurrent) {
        if (result.value) {
          await waitForThreadShell({
            environmentId: result.value.ownerEnvironmentId,
            threadId: result.value.threadId,
          });
          await navigate({
            to: "/bots/$environmentId/$threadId",
            params: {
              environmentId: result.value.ownerEnvironmentId,
              threadId: result.value.threadId,
            },
            replace: true,
          });
        } else {
          setLastBotId(null);
          await navigate({ to: "/bots", replace: true });
        }
      }
    }
    setMoving(null);
  };
  const paused = (bot: BotIdentity) =>
    records.find((record) => record.bot.id === bot.id && record.bot.status === "transferring") ??
    records.find(
      (record) =>
        record.bot.id === bot.id &&
        record.bot.status === "forwarded" &&
        !records.some(
          (candidate) =>
            candidate.bot.id === bot.id &&
            candidate.bot.status === "active" &&
            candidate.bot.generation >= record.bot.generation,
        ),
    );
  const resume = (bot: BotIdentity) => {
    const source = paused(bot);
    if (source?.bot.destinationEnvironmentId)
      void transfer(source.bot, source.environmentId, source.bot.destinationEnvironmentId);
  };
  const cancelPaused = (bot: BotIdentity) => {
    const source = paused(bot);
    if (source?.bot.status === "transferring") void cancel(source.bot, source.environmentId);
  };
  return (
    <BotActionsContext
      value={{ open, busy: moving, canMove, resume, cancel: cancelPaused, paused }}
    >
      {children}
      <Dialog
        open={renameBot !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setRenameBot(null);
        }}
      >
        <DialogPopup showCloseButton={!moving}>
          <DialogHeader>
            <DialogTitle>Rename bot</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <form
              id={renameFormId}
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <Label htmlFor="bot-rename-name">Name</Label>
              <Input
                id="bot-rename-name"
                maxLength={255}
                autoFocus
                value={name}
                disabled={moving !== null}
                onChange={(event) => setName(event.target.value)}
              />
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              disabled={moving !== null}
              onClick={() => setRenameBot(null)}
            >
              Cancel
            </Button>
            <Button type="submit" form={renameFormId} disabled={!name.trim() || moving !== null}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={moveBot !== null}
        onOpenChange={(open) => {
          if (!open && moving === null) setMoveBot(null);
        }}
      >
        <DialogPopup showCloseButton={moving === null}>
          <DialogHeader>
            <DialogTitle>Move {moveBot?.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-2">
              <Label>From</Label>
              <p className="text-sm text-muted-foreground">
                {moveOwner?.label ?? moveBot?.ownerEnvironmentId}
              </p>
            </div>
            <BotEnvironmentSelect
              label="To"
              environments={moveDestinations}
              value={moveDestination?.environmentId ?? null}
              disabled={moving !== null}
              onChange={setMoveDestinationId}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={moving !== null} onClick={() => setMoveBot(null)}>
              Cancel
            </Button>
            {moveBot && moveDestination ? (
              <BotActionButton
                environmentId={moveBot.ownerEnvironmentId}
                destinationEnvironmentId={moveDestination.environmentId}
                disabled={moving !== null}
                onClick={() => {
                  const bot = moveBot;
                  setMoveBot(null);
                  void transfer(bot, bot.ownerEnvironmentId, moveDestination.environmentId);
                }}
              >
                Move bot
              </BotActionButton>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setConfirmation(null);
        }}
      >
        <DialogPopup showCloseButton={!moving}>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.action === "delete" ? "Delete" : "Reset"} {confirmation?.bot.name}?
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "delete"
                ? "Delete this bot and its conversations. This cannot be undone."
                : "Clear this bot's memory and start a fresh conversation. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={moving !== null}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            {confirmation ? (
              <BotActionButton
                environmentId={confirmation.bot.ownerEnvironmentId}
                variant="destructive"
                disabled={moving !== null}
                onClick={() => void confirm()}
              >
                {confirmation.action === "delete" ? "Delete bot" : "Reset memory"}
              </BotActionButton>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </BotActionsContext>
  );
}

/** Whether the viewer may change an active, connected bot; busy transfers are checked separately. */
export function useBotMenuDisabled(bot: Pick<BotIdentity, "ownerEnvironmentId" | "status">) {
  const { environments } = useEnvironments();
  const allowed = useAtomValue(botReset.permissionAtom(bot.ownerEnvironmentId));
  const environment = environments.find((env) => env.environmentId === bot.ownerEnvironmentId);
  return !allowed || environment?.connection.phase !== "connected" || bot.status !== "active";
}

/** Runs a lifecycle item from `buildBotMenuItems`; returns false for ids it does not own. */
export function runBotMenuAction(
  actions: ReturnType<typeof useBotActions>,
  bot: BotIdentity,
  action: string,
) {
  switch (action) {
    case "rename":
    case "move":
    case "reset":
    case "delete":
      actions.open(bot, action);
      return true;
    case "resume":
      actions.resume(bot);
      return true;
    case "cancel":
      actions.cancel(bot);
      return true;
    default:
      return false;
  }
}
