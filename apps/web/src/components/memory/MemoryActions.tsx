import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createContext, useContext, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AtomRegistry } from "effect/reactivity";
import * as Effect from "effect/Effect";
import type { EnvironmentId, MemoryIdentity } from "@t3tools/contracts";
import { MoreHorizontalIcon, RotateCcwIcon, Trash2Icon, ArrowRightLeftIcon } from "lucide-react";
import { waitForThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  useMemoryRecords,
  useMemoryThreadContext,
  useLastMemoryId,
  memoryList,
  memoryReset,
  memoryDelete,
  memoryTransferBegin,
  memoryTransferRead,
  memoryTransferWrite,
  memoryTransferStage,
  memoryTransferRelease,
  memoryTransferActivate,
  memoryTransferCancel,
} from "../../state/memories";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { MemoryEnvironmentSelect } from "./MemoryEnvironmentSelect";
import { MemoryActionButton } from "./MemoryActionButton";

type MemoryAction = "reset" | "delete" | "move";
const MemoryActionsContext = createContext<{
  open: (memory: MemoryIdentity, action: MemoryAction) => void;
  busy: string | null;
  canMove: (memory: MemoryIdentity) => boolean;
  resume: (memory: MemoryIdentity) => void;
  cancel: (memory: MemoryIdentity) => void;
  paused: (memory: MemoryIdentity) => ReturnType<typeof useMemoryRecords>[number] | undefined;
} | null>(null);

export function useMemoryActions() {
  const context = useContext(MemoryActionsContext);
  if (!context) throw new Error("Memory actions require their provider.");
  return context;
}

export function MemoryActionsProvider({ children }: { children: ReactNode }) {
  const { environments } = useEnvironments();
  const registry = useContext(RegistryContext);
  const records = useMemoryRecords();
  const navigate = useNavigate();
  const currentMemory = useMemoryThreadContext(useThreadRouteRef());
  const [, setLastMemoryId] = useLastMemoryId();
  const resetMemory = useAtomCommand(memoryReset);
  const deleteMemory = useAtomCommand(memoryDelete);
  const beginTransfer = useAtomCommand(memoryTransferBegin);
  const readTransfer = useAtomCommand(memoryTransferRead);
  const writeTransfer = useAtomCommand(memoryTransferWrite);
  const stageTransfer = useAtomCommand(memoryTransferStage);
  const releaseTransfer = useAtomCommand(memoryTransferRelease);
  const activateTransfer = useAtomCommand(memoryTransferActivate);
  const cancelTransfer = useAtomCommand(memoryTransferCancel);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveMemory, setMoveMemory] = useState<MemoryIdentity | null>(null);
  const [moveDestinationId, setMoveDestinationId] = useState<EnvironmentId | null>(null);
  const [confirmation, setConfirmation] = useState<{
    memory: MemoryIdentity;
    action: "reset" | "delete";
  } | null>(null);
  const refresh = () => {
    for (const environment of environments)
      registry.refresh(memoryList({ environmentId: environment.environmentId, input: {} }));
  };
  const transfer = async (
    memory: MemoryIdentity,
    source: EnvironmentId,
    destination: EnvironmentId,
  ) => {
    if (moving) return;
    setMoving(memory.id);
    const move = async () => {
      const begun = await beginTransfer({
        environmentId: source,
        input: { memoryId: memory.id, destinationEnvironmentId: destination },
      });
      if (begun._tag !== "Success") return;
      const descriptor = begun.value;
      for (let offset = 0; offset < descriptor.length;) {
        const chunk = await readTransfer({
          environmentId: source,
          input: { memoryId: memory.id, transferId: descriptor.transferId, offset },
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
        input: { memoryId: memory.id, transferId: descriptor.transferId },
      });
      if (released._tag !== "Success") return;
      await activateTransfer({
        environmentId: destination,
        input: {
          memoryId: memory.id,
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
  const cancel = async (memory: MemoryIdentity, source: EnvironmentId) => {
    const destinationEnvironmentId = memory.destinationEnvironmentId;
    if (!destinationEnvironmentId || moving) return;
    setMoving(memory.id);
    const cancelMove = async () => {
      const descriptor = await beginTransfer({
        environmentId: source,
        input: { memoryId: memory.id, destinationEnvironmentId },
      });
      if (descriptor._tag === "Success")
        await cancelTransfer({
          environmentId: source,
          input: { memoryId: memory.id, transferId: descriptor.value.transferId },
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
    (item) => item.environmentId !== moveMemory?.ownerEnvironmentId,
  );
  const moveDestination =
    moveDestinations.find((item) => item.environmentId === moveDestinationId) ??
    moveDestinations[0];
  const moveOwner = environments.find(
    (item) => item.environmentId === moveMemory?.ownerEnvironmentId,
  );
  const canMove = (memory: MemoryIdentity) =>
    memory.status === "active" &&
    connectedEnvironments.some((item) => item.environmentId !== memory.ownerEnvironmentId);
  const open = (memory: MemoryIdentity, action: MemoryAction) => {
    if (moving) return;
    if (action === "move") {
      setMoveDestinationId(null);
      setMoveMemory(memory);
    } else setConfirmation({ memory, action });
  };
  const confirm = async () => {
    if (!confirmation || moving) return;
    const { memory, action } = confirmation;
    const wasCurrent = currentMemory?.memoryId === memory.id;
    setMoving(memory.id);
    const result =
      action === "reset"
        ? await resetMemory({
            environmentId: memory.ownerEnvironmentId,
            input: { memoryId: memory.id },
          })
        : await deleteMemory({
            environmentId: memory.ownerEnvironmentId,
            input: { memoryId: memory.id },
          });
    if (result._tag === "Success") {
      const query = memoryList({ environmentId: memory.ownerEnvironmentId, input: {} });
      registry.refresh(query);
      await Effect.runPromise(
        AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }),
      ).catch(() => undefined);
      setConfirmation(null);
      if (wasCurrent) {
        if (result.value) {
          await waitForThreadShell({
            environmentId: result.value.ownerEnvironmentId,
            threadId: result.value.threadId,
          });
          await navigate({
            to: "/memory/$environmentId/$threadId",
            params: {
              environmentId: result.value.ownerEnvironmentId,
              threadId: result.value.threadId,
            },
            replace: true,
          });
        } else {
          setLastMemoryId(null);
          await navigate({ to: "/memory", replace: true });
        }
      }
    }
    setMoving(null);
  };
  const paused = (memory: MemoryIdentity) =>
    records.find(
      (record) => record.memory.id === memory.id && record.memory.status === "transferring",
    ) ??
    records.find(
      (record) =>
        record.memory.id === memory.id &&
        record.memory.status === "forwarded" &&
        !records.some(
          (candidate) =>
            candidate.memory.id === memory.id &&
            candidate.memory.status === "active" &&
            candidate.memory.generation >= record.memory.generation,
        ),
    );
  const resume = (memory: MemoryIdentity) => {
    const source = paused(memory);
    if (source?.memory.destinationEnvironmentId)
      void transfer(source.memory, source.environmentId, source.memory.destinationEnvironmentId);
  };
  const cancelPaused = (memory: MemoryIdentity) => {
    const source = paused(memory);
    if (source?.memory.status === "transferring") void cancel(source.memory, source.environmentId);
  };
  return (
    <MemoryActionsContext
      value={{ open, busy: moving, canMove, resume, cancel: cancelPaused, paused }}
    >
      {children}
      <Dialog
        open={moveMemory !== null}
        onOpenChange={(open) => {
          if (!open && moving === null) setMoveMemory(null);
        }}
      >
        <DialogPopup showCloseButton={moving === null}>
          <DialogHeader>
            <DialogTitle>Move {moveMemory?.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-2">
              <Label>From</Label>
              <p className="text-sm text-muted-foreground">
                {moveOwner?.label ?? moveMemory?.ownerEnvironmentId}
              </p>
            </div>
            <MemoryEnvironmentSelect
              label="To"
              environments={moveDestinations}
              value={moveDestination?.environmentId ?? null}
              disabled={moving !== null}
              onChange={setMoveDestinationId}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={moving !== null}
              onClick={() => setMoveMemory(null)}
            >
              Cancel
            </Button>
            {moveMemory && moveDestination ? (
              <MemoryActionButton
                environmentId={moveMemory.ownerEnvironmentId}
                destinationEnvironmentId={moveDestination.environmentId}
                disabled={moving !== null}
                onClick={() => {
                  const memory = moveMemory;
                  setMoveMemory(null);
                  void transfer(memory, memory.ownerEnvironmentId, moveDestination.environmentId);
                }}
              >
                Move memory
              </MemoryActionButton>
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
              {confirmation?.action === "delete" ? "Delete" : "Reset"} {confirmation?.memory.name}?
            </DialogTitle>
            <DialogDescription>
              {confirmation?.action === "delete"
                ? "Delete this memory and its conversations. This cannot be undone."
                : "Clear this memory and start a fresh conversation. This cannot be undone."}
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
              <MemoryActionButton
                environmentId={confirmation.memory.ownerEnvironmentId}
                variant="destructive"
                disabled={moving !== null}
                onClick={() => void confirm()}
              >
                {confirmation.action === "delete" ? "Delete memory" : "Reset memory"}
              </MemoryActionButton>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </MemoryActionsContext>
  );
}

export function MemoryActionsMenu({ memory }: { memory: MemoryIdentity }) {
  const actions = useMemoryActions();
  const { environments } = useEnvironments();
  const allowed = useAtomValue(memoryReset.permissionAtom(memory.ownerEnvironmentId));
  const connected = environments.some(
    (env) =>
      env.environmentId === memory.ownerEnvironmentId && env.connection.phase === "connected",
  );
  const disabled = !allowed || !connected || actions.busy !== null || memory.status !== "active";
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={`${memory.name} actions`} />}
      >
        <MoreHorizontalIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {actions.paused(memory) ? (
          <>
            <MenuItem disabled={actions.busy !== null} onClick={() => actions.resume(memory)}>
              Resume transfer
            </MenuItem>
            {actions.paused(memory)?.memory.status === "transferring" ? (
              <MenuItem disabled={actions.busy !== null} onClick={() => actions.cancel(memory)}>
                Cancel transfer
              </MenuItem>
            ) : null}
          </>
        ) : null}
        {actions.canMove(memory) ? (
          <MenuItem disabled={disabled} onClick={() => actions.open(memory, "move")}>
            <ArrowRightLeftIcon />
            Transfer to another environment…
          </MenuItem>
        ) : null}
        <MenuItem disabled={disabled} onClick={() => actions.open(memory, "reset")}>
          <RotateCcwIcon />
          Reset memory…
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={disabled}
          onClick={() => actions.open(memory, "delete")}
        >
          <Trash2Icon />
          Delete memory…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
