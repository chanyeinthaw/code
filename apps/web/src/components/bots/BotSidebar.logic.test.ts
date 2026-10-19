import { describe, expect, it } from "vite-plus/test";
import type { CollisionDetection } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";
import { createSidebarCollisionDetection, createSidebarSortingStrategy } from "../Sidebar.drag";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  planSidebarThreadDrop,
} from "../Sidebar.logic";
import { botSidebarItems } from "./BotSidebar.logic";

function dragFixture(pins: string[], active: string[], source: string, scale = 1) {
  const items = botSidebarItems(pins, active);
  let top = 100;
  const rects = items.map((item) => {
    const height = item.kind === "thread" ? 68 * scale : 0;
    const rect = { top, bottom: top + height, left: 0, right: 260, width: 260, height };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === source);
  const sourceRect = rects[activeIndex]!;
  const dividerIndex = items.findIndex(
    (item) => sidebarListItemId(item) === sidebarMarkerId("pinned-divider"),
  );
  let boundaryTop = rects[dividerIndex]!.top + 4;
  const boundaryNode = {
    querySelector: () => ({
      getBoundingClientRect: () => ({
        top: boundaryTop,
        bottom: boundaryTop + 16,
        left: 0,
        right: 260,
      }),
    }),
  } as unknown as HTMLElement;
  const detector = createSidebarCollisionDetection(() => true, {
    items,
    activationY: sourceRect.top + sourceRect.height / 2,
  });
  const strategy = createSidebarSortingStrategy({
    items,
    boundaryLabelHeight: 24,
    layoutScale: scale,
    settledOrder: [],
    settledExpanded: false,
  });
  const project = (overId: string) => {
    const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
    const layout = {
      rects,
      activeIndex,
      overIndex,
      activeNodeRect: sourceRect,
      index: dividerIndex,
    } satisfies Parameters<SortingStrategy>[0];
    boundaryTop = rects[dividerIndex]!.top + (strategy(layout)?.y ?? 0) + 4;
    return items.map((item, index) => {
      const transform = strategy({ ...layout, index });
      return {
        id: sidebarListItemId(item),
        transform,
        top: rects[index]!.top + (transform?.y ?? 0),
        height: rects[index]!.height,
      };
    });
  };
  const at = (pointerY: number) => {
    const collisionRect = {
      ...sourceRect,
      top: pointerY - sourceRect.height / 2,
      bottom: pointerY + sourceRect.height / 2,
    };
    const args = {
      active: {
        id: source,
        data: { current: {} },
        rect: { current: { initial: sourceRect, translated: collisionRect } },
      },
      collisionRect,
      pointerCoordinates: { x: 130, y: pointerY },
      droppableRects: new Map(items.map((item, index) => [sidebarListItemId(item), rects[index]!])),
      droppableContainers: items.map((item, index) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: index === dividerIndex ? boundaryNode : null },
        rect: { current: rects[index]! },
      })),
    } satisfies Parameters<CollisionDetection>[0];
    const over = detector(args)[0]?.id;
    return over === undefined ? null : resolveSidebarDropTarget(items, source, String(over));
  };
  return { items, project, at, boundaryY: () => boundaryTop + 8 };
}

describe("bot sidebar dragging", () => {
  it.each([1, 1.5])(
    "keeps full-height section labels around shorter bot cards at scale %s",
    (scale) => {
      const fixture = dragFixture(["pin"], ["source", "other"], "source", scale);
      const projected = fixture.project("source");
      const header = projected.find((item) => item.id === sidebarMarkerId("pinned-header"))!;
      const pin = projected.find((item) => item.id === "pin")!;
      const divider = projected.find((item) => item.id === sidebarMarkerId("pinned-divider"))!;
      const other = projected.find((item) => item.id === "other")!;
      expect(pin.top - header.top).toBe(24 * scale + 1);
      expect(divider.top - pin.top).toBe(pin.height + 1);
      expect(other.top - divider.top).toBe(24 * scale + 1 + 68 * scale + 1);
    },
  );

  it.each([{ pins: [] }, { pins: ["existing-pin"] }])(
    "pins an active bot across the divider with pinned bots $pins",
    ({ pins }) => {
      const fixture = dragFixture(pins, ["other", "source"], "source");
      fixture.project("source");
      const pointerY = fixture.boundaryY();
      const target = fixture.at(pointerY);
      expect(target?.section).toBe("pinned");
      expect(target?.pinnedOrder).toContain("source");
      if (!target) throw new Error("Missing pinned drop target");
      const plan = planSidebarThreadDrop({
        activeKey: "source",
        activeSection: "active",
        target,
        pinnedOrder: pins,
        pinnedKeysById: new Map(pins.map((id) => [id, "a0"])),
        activeOrder: ["other", "source"],
        activeKeysById: new Map(),
        supportsSettlement: false,
      });
      expect(plan.kind).toBe("pin");
      if (plan.kind === "pin") expect(plan.orderKey).toBeTruthy();
      // Expanding the destination moves the divider under a stationary pointer.
      fixture.project(sidebarMarkerId("pinned-header"));
      expect(fixture.at(pointerY)?.section).toBe("pinned");
    },
  );

  it("opens a sortable destination for unpinning the only pinned bot into empty Active", () => {
    const fixture = dragFixture(["source"], [], "source");
    const target = resolveSidebarDropTarget(
      fixture.items,
      "source",
      sidebarMarkerId("active-placeholder"),
    );
    expect(target?.section).toBe("active");
    expect(target?.activeOrder).toEqual(["source"]);
    const projected = fixture.project(sidebarMarkerId("active-placeholder"));
    expect(
      projected.find((item) => item.id === sidebarMarkerId("active-placeholder"))?.transform
        ?.scaleY,
    ).toBe(0);
  });
});
