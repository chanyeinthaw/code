import { useAtomValue } from "@effect/atom-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PinIcon } from "lucide-react";
import {
  resolveEnvironmentMachineKind,
  type MemoryIdentity,
  type ContextMenuItem,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import {
  memoryReset,
  useMemories,
  useMemoryThreadContext,
  useMemoryThreadShells,
} from "../../state/memories";
import { useEnvironments } from "../../state/environments";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useProject } from "../../state/entities";
import { cn } from "../../lib/utils";
import { pinOrderKeyBetween, resolveThreadStatusPill } from "../Sidebar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AlternateSidebarHeader } from "../alternate-layout/AlternateSidebarHeader";
import { SidebarHeaderSearch } from "../sidebar/SidebarThreadHeader";
import { NewMemoryButton } from "./NewMemoryButton";
import { MemoryActionsProvider, useMemoryActions } from "./MemoryActions";

type MemoryRow = { memory: MemoryIdentity; thread: EnvironmentThreadShell | undefined };
const isPinned = (row: MemoryRow) => row.thread?.pinnedAt != null;
const orderKey = (row: MemoryRow) =>
  (isPinned(row) ? row.thread?.pinOrderKey : row.thread?.activeOrderKey) ?? null;

export function MemorySidebar() {
  return (
    <MemoryActionsProvider>
      <MemorySidebarContent />
    </MemoryActionsProvider>
  );
}

function MemorySidebarContent() {
  const memories = useMemories();
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const query = searchQuery.trim().toLocaleLowerCase();
  const threads = useMemoryThreadShells();
  const pin = useOrchestrationCommand(threadEnvironment.pin);
  const unpin = useOrchestrationCommand(threadEnvironment.unpin);
  const reorderPin = useOrchestrationCommand(threadEnvironment.reorderPin);
  const reorderActive = useOrchestrationCommand(threadEnvironment.reorderActive);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const rows = memories.map((memory) => ({
    memory,
    thread: threads.find(
      (thread) =>
        thread.id === memory.threadId && thread.environmentId === memory.ownerEnvironmentId,
    ),
  }));
  rows.sort((a, b) => {
    const aKey = orderKey(a),
      bKey = orderKey(b);
    if (aKey !== null && bKey !== null && aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (aKey !== null) return -1;
    if (bKey !== null) return 1;
    return a.memory.name.localeCompare(b.memory.name) || a.memory.id.localeCompare(b.memory.id);
  });
  const pinned = rows.filter(isPinned);
  const active = rows.filter((row) => !isPinned(row));
  const matchesSearch = (row: MemoryRow) => row.memory.name.toLocaleLowerCase().includes(query);
  const visiblePinned = pinned.filter(matchesSearch);
  const visibleActive = active.filter(matchesSearch);
  const togglePin = (row: MemoryRow) => {
    const input = {
      environmentId: row.memory.ownerEnvironmentId,
      input: { threadId: row.memory.threadId },
    };
    if (isPinned(row)) void unpin(input);
    else {
      const key = pinOrderKeyBetween(null, pinned[0] ? orderKey(pinned[0]) : null);
      void pin({ ...input, input: { ...input.input, ...(key ? { orderKey: key } : {}) } });
    }
  };
  const onDragEnd = async ({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id) return;
    const source = rows.find((row) => row.memory.id === dragged.id);
    const target = rows.find((row) => row.memory.id === over.id);
    if (!source) return;
    const destinationPinned = target ? isPinned(target) : over.id === "pinned-memories";
    const destination = destinationPinned ? pinned : active;
    const sourceIndex = destination.findIndex((row) => row.memory.id === source.memory.id);
    const targetIndex = destination.findIndex((row) => row.memory.id === target?.memory.id);
    const next =
      sourceIndex >= 0 && targetIndex >= 0
        ? arrayMove(destination, sourceIndex, targetIndex)
        : destination.filter((row) => row.memory.id !== source.memory.id);
    if (sourceIndex < 0 || targetIndex < 0)
      next.splice(targetIndex >= 0 ? targetIndex : next.length, 0, source);
    const writes = planPinnedReorder({
      orderedIds: next.map((row) => row.memory.id),
      keysById: new Map(destination.map((row) => [row.memory.id, orderKey(row)])),
      movedId: source.memory.id,
    });
    for (const write of writes) {
      const row = next.find((row) => row.memory.id === write.id);
      if (!row) continue;
      const environmentId = row.memory.ownerEnvironmentId;
      const input = { threadId: row.memory.threadId, orderKey: write.orderKey };
      if (destinationPinned && !isPinned(row)) {
        const result = await pin({ environmentId, input });
        if (result._tag !== "Success") return;
      } else {
        if (!destinationPinned && isPinned(row)) {
          const result = await unpin({ environmentId, input: { threadId: row.memory.threadId } });
          if (result._tag !== "Success") return;
        }
        const result = await (destinationPinned ? reorderPin : reorderActive)({
          environmentId,
          input,
        });
        if (result._tag !== "Success") return;
      }
    }
  };
  return (
    <>
      <AlternateSidebarHeader />
      <div className="shrink-0 p-2">
        <div className="flex items-center gap-1">
          <SidebarHeaderSearch
            label="Search memories"
            clearLabel="Clear memory search"
            searchInputRef={searchInputRef}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchKeyDown={(event) => {
              if (event.key === "Escape") setSearchQuery("");
            }}
            isSearching={query.length > 0}
            onClearSearch={() => setSearchQuery("")}
          />
          <NewMemoryButton sidebar />
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void onDragEnd(event)}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {query && visiblePinned.length + visibleActive.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No memories found</div>
          ) : null}
          <MemorySection
            id="pinned-memories"
            label="Pinned"
            rows={visiblePinned}
            onTogglePin={togglePin}
            searching={query.length > 0}
          />
          <MemorySection
            id="active-memories"
            label="Memories"
            rows={visibleActive}
            onTogglePin={togglePin}
            searching={query.length > 0}
          />
        </div>
      </DndContext>
    </>
  );
}

function MemorySection({
  id,
  label,
  rows,
  onTogglePin,
  searching,
}: {
  id: string;
  label: string;
  rows: MemoryRow[];
  onTogglePin: (row: MemoryRow) => void;
  searching: boolean;
}) {
  const { setNodeRef } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className="min-h-2" aria-label={label}>
      <SortableContext
        items={rows.map((row) => row.memory.id)}
        strategy={verticalListSortingStrategy}
      >
        {rows.map((row) => (
          <MemorySidebarItem
            key={row.memory.id}
            row={row}
            searching={searching}
            onTogglePin={() => onTogglePin(row)}
          />
        ))}
      </SortableContext>
    </section>
  );
}

function MemorySidebarItem({
  row,
  onTogglePin,
  searching,
}: {
  row: MemoryRow;
  onTogglePin: () => void;
  searching: boolean;
}) {
  const { memory, thread } = row;
  const [prewarm, setPrewarm] = useState(false);
  const { environments } = useEnvironments();
  const actions = useMemoryActions();
  const current = useMemoryThreadContext(useThreadRouteRef());
  const allowed = useAtomValue(memoryReset.permissionAtom(memory.ownerEnvironmentId));
  const environment = environments.find((env) => env.environmentId === memory.ownerEnvironmentId);
  const disabled =
    !allowed || environment?.connection.phase !== "connected" || memory.status !== "active";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: memory.id,
    disabled: disabled || searching,
  });
  const selected = current?.memoryId === memory.id;
  const status = thread ? resolveThreadStatusPill({ thread }) : null;
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: thread ? { environmentId: thread.environmentId, threadId: thread.id } : null,
    projectCwd: project?.workspaceRoot ?? null,
    onStartRename: () => {},
    actions: ["copy", "project-settings"],
  });
  const showMenu = (position: { x: number; y: number }) => {
    const items: ContextMenuItem[] = [
      {
        id: "pin",
        label: isPinned(row) ? "Unpin" : "Pin",
        icon: isPinned(row) ? "pin-off" : "pin",
        disabled,
      },
      ...(actions.canMove(memory)
        ? [{ id: "move", label: "Transfer to another environment…", disabled }]
        : []),
      ...(actions.paused(memory)
        ? [
            { id: "resume", label: "Resume transfer", disabled: actions.busy !== null },
            ...(actions.paused(memory)?.memory.status === "transferring"
              ? [{ id: "cancel", label: "Cancel transfer", disabled: actions.busy !== null }]
              : []),
          ]
        : []),
      {
        id: "reset",
        label: "Reset memory…",
        icon: "refresh-cw",
        separatorBefore: true,
        disabled: disabled || actions.busy !== null,
      },
      {
        id: "delete",
        label: "Delete memory…",
        icon: "trash",
        destructive: true,
        disabled: disabled || actions.busy !== null,
      },
    ];
    openMenu(position, {
      items,
      sharedItemsIndex: 1,
      onSelect: (action) => {
        if (action === "pin") onTogglePin();
        else if (action === "reset" || action === "delete" || action === "move")
          actions.open(memory, action);
        else if (action === "resume") actions.resume(memory);
        else if (action === "cancel") actions.cancel(memory);
      },
    });
  };
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="listitem"
      className={cn("relative mb-1 rounded-lg", isDragging && "z-50 opacity-60")}
    >
      {prewarm ? <MemoryThreadPrewarmer memory={memory} /> : null}
      <Link
        onPointerEnter={() => setPrewarm(true)}
        onFocus={() => setPrewarm(true)}
        to="/memory/$environmentId/$threadId"
        params={{ environmentId: memory.ownerEnvironmentId, threadId: memory.threadId }}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-h-16 flex-col gap-1 rounded-lg px-3 py-2 text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected ? "bg-sidebar-row-selected" : status ? "bg-sidebar-row-active" : "",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          void showMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            void showMenu({ x: bounds.left, y: bounds.bottom });
          }
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
            className="size-3"
          />
          <span className="min-w-0 flex-1 truncate">
            {environment?.label ?? memory.ownerEnvironmentId}
          </span>
          {isPinned(row) ? <PinIcon className="size-3" /> : null}
          {status ? (
            <span className={cn("flex shrink-0 items-center gap-1", status.colorClass)}>
              <span className={cn("size-1.5 rounded-full", status.dotClass)} />
              {status.label === "Completed" ? "Done" : status.label}
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm">{memory.name}</span>
      </Link>
    </div>
  );
}

function MemoryThreadPrewarmer({ memory }: { memory: MemoryIdentity }) {
  useEnvironmentThread(memory.ownerEnvironmentId, memory.threadId);
  return null;
}
