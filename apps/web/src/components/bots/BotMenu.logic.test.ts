import { describe, expect, it } from "vite-plus/test";
import { buildBotMenuItems } from "./BotMenu.logic";

const base = { pinned: false, disabled: false, busy: false, canMove: true, paused: null } as const;
const ids = (items: ReturnType<typeof buildBotMenuItems>) => items.map((item) => item.id);

describe("bot menu", () => {
  it("lists the lifecycle actions in order, toggling Pin by pinned state", () => {
    expect(ids(buildBotMenuItems(base))).toEqual(["pin", "rename", "move", "reset", "delete"]);
    expect(buildBotMenuItems(base)[0]).toMatchObject({ label: "Pin", icon: "pin" });
    expect(buildBotMenuItems({ ...base, pinned: true })[0]).toMatchObject({
      label: "Unpin",
      icon: "pin-off",
    });
  });

  it("hides Transfer when no other environment can take the bot", () => {
    expect(ids(buildBotMenuItems({ ...base, canMove: false }))).not.toContain("move");
  });

  it("offers Cancel only while the transfer can still be cancelled", () => {
    expect(ids(buildBotMenuItems({ ...base, paused: "forwarded" }))).toContain("resume");
    expect(ids(buildBotMenuItems({ ...base, paused: "forwarded" }))).not.toContain("cancel");
    expect(ids(buildBotMenuItems({ ...base, paused: "transferring" }))).toContain("cancel");
  });

  it("keeps resume and cancel enabled when the bot is not active, but locks them while busy", () => {
    const items = buildBotMenuItems({
      ...base,
      disabled: true,
      paused: "transferring",
    });
    expect(items.find((item) => item.id === "resume")?.disabled).toBe(false);
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    const busy = buildBotMenuItems({ ...base, busy: true, paused: "transferring" });
    expect(busy.find((item) => item.id === "cancel")?.disabled).toBe(true);
    expect(busy.find((item) => item.id === "delete")?.disabled).toBe(true);
    expect(busy.find((item) => item.id === "rename")?.disabled).toBe(false);
  });
});
