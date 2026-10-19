import type { SensorProps } from "@dnd-kit/core";
import { getOwnerDocument, getWindow } from "@dnd-kit/utilities";
import { describe, expect, it, vi } from "vite-plus/test";
import { SidebarPointerSensor } from "./Sidebar.pointer";

vi.mock("@dnd-kit/utilities", () => ({
  getOwnerDocument: vi.fn(),
  getWindow: vi.fn(),
}));

function pointer(type: string, clientY = 10) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    clientX: 10,
    clientY,
    buttons: type === "pointerup" ? 0 : 1,
  });
}

function setup() {
  const document = Object.assign(new EventTarget(), { getSelection: () => null });
  vi.mocked(getOwnerDocument).mockReturnValue(document as unknown as Document);
  vi.mocked(getWindow).mockReturnValue(
    new EventTarget() as unknown as ReturnType<typeof getWindow>,
  );
  const sensor = new SidebarPointerSensor({
    active: "bot",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish: vi.fn() },
    onPending: vi.fn(),
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>);
  return {
    document,
    sensor,
    [Symbol.dispose]() {
      sensor.cancel();
      document.dispatchEvent(pointer("pointerdown"));
    },
  };
}

describe("sidebar drag link navigation", () => {
  it.each(["drop", "cancel"])("prevents native link navigation after a drag %s", (finish) => {
    using drag = setup();
    drag.document.dispatchEvent(pointer("pointermove", 30));
    if (finish === "cancel") drag.sensor.cancel();
    else drag.document.dispatchEvent(pointer("pointerup", 30));

    const releaseClick = new Event("click", { bubbles: true, cancelable: true });
    expect(drag.document.dispatchEvent(releaseClick)).toBe(false);
    expect(releaseClick.defaultPrevented).toBe(true);

    drag.document.dispatchEvent(pointer("pointerdown"));
    const nextClick = new Event("click", { bubbles: true, cancelable: true });
    expect(drag.document.dispatchEvent(nextClick)).toBe(true);
  });

  it("preserves ordinary clicks when the pointer never starts dragging", () => {
    using drag = setup();
    drag.document.dispatchEvent(pointer("pointermove", 12));
    drag.document.dispatchEvent(pointer("pointerup", 12));
    expect(drag.document.dispatchEvent(new Event("click", { cancelable: true }))).toBe(true);
  });
});
