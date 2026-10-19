import type { SidebarListItem } from "../Sidebar.logic";

export function botSidebarItems(
  pinned: readonly string[],
  active: readonly string[],
): SidebarListItem[] {
  return [
    { kind: "marker", marker: "pinned-header" },
    ...pinned.map((key): SidebarListItem => ({ kind: "thread", key, section: "pinned" })),
    { kind: "marker", marker: "pinned-divider" },
    { kind: "marker", marker: "active-placeholder" },
    ...active.map((key): SidebarListItem => ({ kind: "thread", key, section: "active" })),
  ];
}
