import type { ContextMenuItem } from "@satslab/contracts";

/**
 * The bot lifecycle menu shared by the sidebar item and the chat header. Pin comes first so the
 * thread menu's Copy and Bot settings can follow it.
 */
export function buildBotMenuItems(input: {
  readonly pinned: boolean;
  /** Missing permission, disconnected owner, or a bot that is not active. */
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly canMove: boolean;
  readonly paused: "transferring" | "forwarded" | null;
}): ContextMenuItem[] {
  const { pinned, disabled, busy, canMove, paused } = input;
  return [
    {
      id: "pin",
      label: pinned ? "Unpin" : "Pin",
      icon: pinned ? "pin-off" : "pin",
      disabled,
    },
    { id: "rename", label: "Rename…", icon: "pencil", disabled },
    ...(canMove ? [{ id: "move", label: "Transfer to another environment…", disabled }] : []),
    ...(paused
      ? [
          { id: "resume", label: "Resume transfer", disabled: busy },
          ...(paused === "transferring"
            ? [{ id: "cancel", label: "Cancel transfer", disabled: busy }]
            : []),
        ]
      : []),
    {
      id: "reset",
      label: "Reset memory…",
      icon: "refresh-cw",
      separatorBefore: true,
      disabled: disabled || busy,
    },
    {
      id: "delete",
      label: "Delete bot…",
      icon: "trash",
      destructive: true,
      disabled: disabled || busy,
    },
  ];
}
