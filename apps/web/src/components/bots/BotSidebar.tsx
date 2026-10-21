import {
  DndContext,
  type DragStartEvent,
  type Modifier,
  type DragOverEvent,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { useLayoutEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { PinIcon, PinOffIcon } from "lucide-react";
import { resolveEnvironmentMachineKind, type BotIdentity } from "@satslab/contracts";
import type { EnvironmentThreadShell } from "@satslab/client-runtime/state/shell";
import { useBots, useBotThreadContext, useBotThreadShells } from "../../state/bots";
import { useEnvironments } from "../../state/environments";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useProject } from "../../state/entities";
import { cn } from "../../lib/utils";
import {
  animateSidebarLayoutChanges,
  resolveThreadStatusPill,
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  type SidebarDropVerb,
  planSidebarThreadDrop,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "../Sidebar.drag";
import { SidebarDragLifecycle, SidebarPointerSensor } from "../Sidebar.pointer";
import { botSidebarItems } from "./BotSidebar.logic";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { AlternateSidebarHeader } from "../alternate-layout/AlternateSidebarHeader";
import { SidebarHeaderSearch } from "../sidebar/SidebarThreadHeader";
import { createSidebarListMotion } from "../Sidebar.motion";
import { toastManager } from "../ui/toast";
import { NewBotButton } from "./NewBotButton";
import {
  BotActionsProvider,
  runBotMenuAction,
  useBotActions,
  useBotMenuDisabled,
} from "./BotActions";
import { buildBotMenuItems } from "./BotMenu.logic";

type BotRow = {
  bot: BotIdentity;
  thread: EnvironmentThreadShell | undefined;
  pinned: boolean;
  orderKey: string | null;
};
type BotPlacement = { id: string; pinned: boolean; orderKey: string | null };
const SORTABLE_DRAG_DISABLED = { draggable: true } as const;
const SORTABLE_DRAG_ENABLED = { draggable: false } as const;
const DRAG_LABEL_HEIGHT = 24;
const isPinned = (row: BotRow) => row.pinned;
const orderKey = (row: BotRow) => row.orderKey;

export function BotSidebar() {
  return (
    <BotActionsProvider>
      <BotSidebarContent />
    </BotActionsProvider>
  );
}

function BotSidebarContent() {
  const bots = useBots();
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const query = searchQuery.trim().toLocaleLowerCase();
  const threads = useBotThreadShells();
  const pin = useOrchestrationCommand(threadEnvironment.pin);
  const unpin = useOrchestrationCommand(threadEnvironment.unpin);
  const reorderPin = useOrchestrationCommand(threadEnvironment.reorderPin);
  const reorderActive = useOrchestrationCommand(threadEnvironment.reorderActive);
  const [optimistic, setOptimistic] = useState<BotPlacement[] | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const dragging = draggedId !== null;
  const [activationY, setActivationY] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<boolean | null>(null);
  const motion = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const sensorRef = useRef<SidebarPointerSensor | null>(null);
  const labelOffsetRef = useRef(0);
  const [layoutScale, setLayoutScale] = useState(1);
  const finishDrag = useStableCallback((started: boolean) => {
    sensorRef.current = null;
    if (!started) return;
    motion.current?.release();
    setDraggedId(null);
    setActivationY(null);
    setDragTarget(null);
  });
  const cancelDrag = useStableCallback(() => sensorRef.current?.cancel());
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, {
      distance: 6,
      onAttach: (sensor: SidebarPointerSensor) => {
        sensorRef.current = sensor;
      },
      onFinish: finishDrag,
    }),
  );
  const setListRef = useStableCallback((node: HTMLUListElement | null) => {
    listRef.current = node;
    motion.current?.dispose();
    motion.current = node ? createSidebarListMotion(node) : null;
    motion.current?.update(false);
    return () => {
      motion.current?.dispose();
      motion.current = null;
    };
  });
  const canonicalRows = bots.map((bot) => {
    const thread = threads.find(
      (thread) => thread.id === bot.threadId && thread.environmentId === bot.ownerEnvironmentId,
    );
    const pinned = thread?.pinnedAt != null;
    return {
      bot,
      thread,
      pinned,
      orderKey: (pinned ? thread?.pinOrderKey : thread?.activeOrderKey) ?? null,
    };
  });
  const caughtUp = optimistic?.every((placement) => {
    const row = canonicalRows.find((row) => row.bot.id === placement.id);
    return !row || (row.pinned === placement.pinned && row.orderKey === placement.orderKey);
  });
  if (caughtUp) setOptimistic(null);
  const placements = caughtUp ? null : optimistic;
  const rows = canonicalRows.map((row) => {
    const placement = placements?.find((placement) => placement.id === row.bot.id);
    return placement ? { ...row, pinned: placement.pinned, orderKey: placement.orderKey } : row;
  });
  rows.sort((a, b) => {
    const aKey = orderKey(a),
      bKey = orderKey(b);
    if (aKey !== null && bKey !== null && aKey !== bKey) return aKey < bKey ? -1 : 1;
    if (aKey !== null) return -1;
    if (bKey !== null) return 1;
    return a.bot.name.localeCompare(b.bot.name) || a.bot.id.localeCompare(b.bot.id);
  });
  const pinned = rows.filter(isPinned);
  const active = rows.filter((row) => !isPinned(row));
  const matchesSearch = (row: BotRow) => row.bot.name.toLocaleLowerCase().includes(query);
  const visiblePinned = pinned.filter(matchesSearch);
  const visibleActive = active.filter(matchesSearch);
  const freshItems = botSidebarItems(
    visiblePinned.map((row) => row.bot.id),
    visibleActive.map((row) => row.bot.id),
  );
  const itemsKey = freshItems
    .map((item) => (item.kind === "thread" ? `${item.section}:${item.key}` : item.marker))
    .join("\n");
  const [retainedItems, setRetainedItems] = useState({ key: itemsKey, items: freshItems });
  if (retainedItems.key !== itemsKey) setRetainedItems({ key: itemsKey, items: freshItems });
  const items = retainedItems.key === itemsKey ? retainedItems.items : freshItems;
  const collisionDetection = createSidebarCollisionDetection(
    (id) => {
      const source = rows.find((row) => row.bot.id === draggedId);
      if (!source) return false;
      const target = resolveSidebarDropTarget(items, source.bot.id, id);
      if (!target) return false;
      return (
        planSidebarThreadDrop({
          activeKey: source.bot.id,
          activeSection: source.pinned ? "pinned" : "active",
          supportsSettlement: false,
          target,
          pinnedOrder: pinned.map((row) => String(row.bot.id)),
          activeOrder: active.map((row) => String(row.bot.id)),
          pinnedKeysById: new Map(pinned.map((row) => [String(row.bot.id), row.orderKey])),
          activeKeysById: new Map(active.map((row) => [String(row.bot.id), row.orderKey])),
        }).kind !== "none"
      );
    },
    { items, activationY },
  );
  const sortingStrategy = createSidebarSortingStrategy({
    items,
    boundaryLabelHeight: DRAG_LABEL_HEIGHT,
    layoutScale,
    settledOrder: [],
    settledExpanded: false,
  });
  const modifiers: Modifier[] = [
    restrictToVerticalAxis,
    (args) => restrictBelowSidebarLabel(args, labelOffsetRef.current),
    restrictToFirstScrollableAncestor,
  ];
  const busy = placements !== null;
  const motionPass = { layoutKey: itemsKey, animate: !dragging && query.length === 0 };
  useLayoutEffect(() => {
    motion.current?.update(motionPass.animate);
  }, [motionPass]);
  useLayoutEffect(() => {
    if (query || (draggedId !== null && !rows.some((row) => row.bot.id === draggedId)))
      cancelDrag();
  }, [query, draggedId, rows, cancelDrag]);
  const commit = async (placements: BotPlacement[], write: () => Promise<boolean>) => {
    setOptimistic(placements);
    try {
      if (await write()) return;
    } catch {
      // Commands normally return a failure result; transport interruption can reject.
    }
    setOptimistic((current) => (current === placements ? null : current));
    toastManager.add({ type: "error", title: "Could not update bot order" });
  };
  const applyOrder = async (source: BotRow, destinationPinned: boolean, next: BotRow[]) => {
    const order = next.map((row) => String(row.bot.id));
    const pinnedOrder = pinned.map((row) => String(row.bot.id));
    const activeOrder = active.map((row) => String(row.bot.id));
    const plan = planSidebarThreadDrop({
      activeKey: source.bot.id,
      activeSection: source.pinned ? "pinned" : "active",
      supportsSettlement: false,
      target: {
        section: destinationPinned ? "pinned" : "active",
        pinnedOrder: destinationPinned ? order : pinnedOrder,
        activeOrder: destinationPinned ? activeOrder : order,
      },
      pinnedOrder,
      activeOrder,
      pinnedKeysById: new Map(pinned.map((row) => [String(row.bot.id), orderKey(row)])),
      activeKeysById: new Map(active.map((row) => [String(row.bot.id), orderKey(row)])),
    });
    if (plan.kind === "none" || plan.kind === "settle") return;
    const writes =
      plan.kind === "pin"
        ? [
            ...(plan.orderKey === undefined
              ? []
              : [{ id: String(source.bot.id), orderKey: plan.orderKey }]),
            ...plan.extraAssignments,
          ]
        : plan.assignments;
    const placements = writes.map((write) => ({
      id: write.id,
      pinned: destinationPinned,
      orderKey: write.orderKey,
    }));
    if (writes.length === 0) return;
    await commit(placements, async () => {
      for (const write of writes) {
        const row = next.find((row) => row.bot.id === write.id);
        if (!row) continue;
        const environmentId = row.bot.ownerEnvironmentId;
        const input = { threadId: row.bot.threadId, orderKey: write.orderKey };
        if (destinationPinned && !isPinned(row)) {
          const result = await pin({ environmentId, input });
          if (result._tag !== "Success") return false;
        } else {
          if (!destinationPinned && isPinned(row)) {
            const result = await unpin({ environmentId, input: { threadId: row.bot.threadId } });
            if (result._tag !== "Success") return false;
          }
          const result = await (destinationPinned ? reorderPin : reorderActive)({
            environmentId,
            input,
          });
          if (result._tag !== "Success") return false;
        }
      }
      return true;
    });
  };
  const togglePin = (row: BotRow) => {
    if (busy) return;
    const destinationPinned = !isPinned(row);
    const destination = destinationPinned ? pinned : active;
    void applyOrder(row, destinationPinned, [row, ...destination]);
  };
  const onDragStart = (event: DragStartEvent) => {
    motion.current?.suspend();
    const list = listRef.current;
    const header = list?.querySelector<HTMLElement>('[data-testid="sidebar-pinned-header"]');
    const scale =
      list && list.offsetWidth > 0 ? list.getBoundingClientRect().width / list.offsetWidth : 1;
    setLayoutScale(scale);
    labelOffsetRef.current =
      list && header
        ? header.getBoundingClientRect().top -
          list.getBoundingClientRect().top +
          DRAG_LABEL_HEIGHT * scale
        : 0;
    setDraggedId(String(event.active.id));
    setActivationY(
      event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
    );
    const source = rows.find((row) => row.bot.id === event.active.id);
    setDragTarget(source ? isPinned(source) : null);
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const target = over
      ? resolveSidebarDropTarget(items, String(active.id), String(over.id))
      : null;
    setDragTarget(target === null ? null : target.section === "pinned");
  };
  const onDragEnd = async ({ active: dragged, over }: DragEndEvent) => {
    if (busy || !over || dragged.id === over.id) return;
    const source = rows.find((row) => row.bot.id === dragged.id);
    const target = resolveSidebarDropTarget(items, String(dragged.id), String(over.id));
    if (!source || !target || target.section === "settled") return;
    const destinationPinned = target.section === "pinned";
    const orderedIds = destinationPinned ? target.pinnedOrder : target.activeOrder;
    const rowsById = new Map(rows.map((row) => [String(row.bot.id), row]));
    const next = orderedIds.flatMap((id) => {
      const row = rowsById.get(id);
      return row ? [row] : [];
    });
    await applyOrder(source, destinationPinned, next);
  };
  return (
    <>
      <AlternateSidebarHeader />
      <div className="shrink-0 p-2">
        <div className="flex items-center gap-1">
          <SidebarHeaderSearch
            label="Search bots"
            clearLabel="Clear bot search"
            searchInputRef={searchInputRef}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearchKeyDown={(event) => {
              if (event.key === "Escape") setSearchQuery("");
            }}
            isSearching={query.length > 0}
            onClearSearch={() => setSearchQuery("")}
          />
          <NewBotButton sidebar />
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={modifiers}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={(event) => void onDragEnd(event)}
      >
        <SidebarDragLifecycle onUnmount={cancelDrag} />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {query && visiblePinned.length + visibleActive.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">No bots found</div>
          ) : null}
          <SortableContext items={items.map(sidebarListItemId)} strategy={sortingStrategy}>
            <ul className="relative flex flex-col gap-px" ref={setListRef}>
              {items.map((item) => {
                if (item.kind === "marker")
                  return (
                    <BotSectionBoundary
                      key={item.marker}
                      marker={item.marker}
                      dragging={dragging}
                      active={
                        item.marker === "pinned-header" ? dragTarget === true : dragTarget === false
                      }
                      emptyActive={
                        visibleActive.length === 0 ||
                        (visibleActive.length === 1 &&
                          visibleActive[0]?.bot.id === draggedId &&
                          dragTarget === true)
                      }
                    />
                  );
                const row = rows.find((row) => row.bot.id === item.key);
                return row ? (
                  <BotSidebarItem
                    key={item.key}
                    row={row}
                    searching={query.length > 0 || busy}
                    onTogglePin={() => togglePin(row)}
                    dropVerb={
                      row.bot.id === draggedId
                        ? resolveSidebarDropVerb(
                            row.pinned ? "pinned" : "active",
                            dragTarget === null ? null : dragTarget ? "pinned" : "active",
                          )
                        : null
                    }
                    dragOverPinned={row.bot.id === draggedId && dragTarget === true}
                  />
                ) : null;
              })}
            </ul>
          </SortableContext>
        </div>
      </DndContext>
    </>
  );
}

function BotSectionBoundary({
  marker,
  dragging,
  active,
  emptyActive,
}: {
  marker: SidebarListMarker;
  dragging: boolean;
  active: boolean;
  emptyActive: boolean;
}) {
  const { setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(marker),
    disabled: SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const placeholder = marker === "active-placeholder";
  return (
    <li
      ref={setNodeRef}
      data-testid={`sidebar-${marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0 list-none"
      style={{
        transform: CSS.Translate.toString(transform),
        transition: placeholder ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {dragging && (!placeholder || emptyActive) ? (
        placeholder ? (
          <div
            className={cn(
              "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed text-xs",
              active
                ? "border-primary/40 bg-primary/5 text-primary"
                : "border-sidebar-foreground/25 text-sidebar-foreground/80",
            )}
          >
            Active
          </div>
        ) : (
          <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
            <span
              className={cn(
                "shrink-0 text-xs font-medium",
                active ? "text-primary" : "text-sidebar-foreground/80",
              )}
            >
              {marker === "pinned-header" ? "Pinned" : "Active"}
            </span>
            <span
              aria-hidden
              className={cn("h-px flex-1", active ? "bg-primary/50" : "bg-sidebar-foreground/25")}
            />
          </div>
        )
      ) : null}
    </li>
  );
}

function BotSidebarItem({
  row,
  onTogglePin,
  searching,
  dropVerb,
  dragOverPinned,
}: {
  row: BotRow;
  onTogglePin: () => void;
  searching: boolean;
  dropVerb: SidebarDropVerb | null;
  dragOverPinned: boolean;
}) {
  const { bot, thread } = row;
  const [prewarm, setPrewarm] = useState(false);
  const { environments } = useEnvironments();
  const actions = useBotActions();
  const current = useBotThreadContext(useThreadRouteRef());
  const environment = environments.find((env) => env.environmentId === bot.ownerEnvironmentId);
  const disabled = useBotMenuDisabled(bot);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: bot.id,
    disabled: disabled || searching ? SORTABLE_DRAG_DISABLED : SORTABLE_DRAG_ENABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  const selected = current?.botId === bot.id;
  const status = thread ? resolveThreadStatusPill({ thread }) : null;
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: thread ? { environmentId: thread.environmentId, threadId: thread.id } : null,
    projectCwd: project?.workspaceRoot ?? null,
    onStartRename: () => {},
    actions: ["copy", "project-settings"],
    projectSettingsLabel: "Bot settings",
  });
  const showMenu = (position: { x: number; y: number }) => {
    const paused = actions.paused(bot);
    openMenu(position, {
      items: buildBotMenuItems({
        pinned: isPinned(row),
        disabled,
        busy: actions.busy !== null,
        canMove: actions.canMove(bot),
        paused: paused
          ? paused.bot.status === "transferring"
            ? "transferring"
            : "forwarded"
          : null,
      }),
      sharedItemsIndex: 1,
      onSelect: (action) => {
        if (action === "pin") onTogglePin();
        else runBotMenuAction(actions, bot, action);
      },
    });
  };
  return (
    <li
      ref={setNodeRef}
      style={{
        // Section markers have zero height; their scale must not flatten the dragged card.
        transform: CSS.Translate.toString(transform),
        transition,
        visibility: !isDragging && transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      {...listeners}
      role="listitem"
      className={cn("relative rounded-lg pb-1", isDragging && "z-20")}
    >
      {prewarm ? <BotThreadPrewarmer bot={bot} /> : null}
      <Link
        draggable={false}
        onPointerEnter={() => setPrewarm(true)}
        onFocus={() => setPrewarm(true)}
        to="/bots/$environmentId/$threadId"
        params={{ environmentId: bot.ownerEnvironmentId, threadId: bot.threadId }}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex min-h-16 select-none flex-col gap-1 rounded-lg px-3 py-2 text-sidebar-foreground outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected ? "bg-sidebar-row-selected" : status ? "bg-sidebar-row-active" : "",
          isDragging &&
            "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
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
            {environment?.label ?? bot.ownerEnvironmentId}
          </span>
          {isPinned(row) && (!isDragging || (dragOverPinned && dropVerb === null)) ? (
            <PinIcon className="size-3" />
          ) : null}
          {isDragging && dropVerb !== null ? (
            <span
              role="status"
              className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
            >
              {dropVerb === "pin" ? (
                <PinIcon className="size-3" />
              ) : (
                <PinOffIcon className="size-3" />
              )}
              {dropVerb === "pin" ? "Pin" : "Unpin"}
            </span>
          ) : status ? (
            <span className={cn("flex shrink-0 items-center gap-1", status.colorClass)}>
              <span className={cn("size-1.5 rounded-full", status.dotClass)} />
              {status.label === "Completed" ? "Done" : status.label}
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm">{bot.name}</span>
      </Link>
    </li>
  );
}

function BotThreadPrewarmer({ bot }: { bot: BotIdentity }) {
  useEnvironmentThread(bot.ownerEnvironmentId, bot.threadId);
  return null;
}
