import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createMemoryHistory } from "@tanstack/react-router";

const settings = vi.hoisted(() => ({
  enabled: true,
  hydrate: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  ensureClientSettingsHydrated: settings.hydrate,
  getClientSettings: () => ({ alternateLayoutEnabled: settings.enabled }),
}));

import { prepareMemoryStartup } from "./memoryStartup";

describe("memory startup navigation", () => {
  beforeEach(() => {
    settings.enabled = true;
    settings.hydrate.mockReset().mockResolvedValue(undefined);
  });

  it("opens memory at startup without changing subsequent navigation to threads", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    await prepareMemoryStartup(history);
    expect(history.location.pathname).toBe("/memory");
    history.push("/");
    expect(history.location.pathname).toBe("/");
  });

  it.each(["/env/thread", "/memory/env/thread", "/settings/memory", "/draft/draft-1"])(
    "preserves a reload at %s",
    async (href) => {
      const history = createMemoryHistory({ initialEntries: [href] });
      await prepareMemoryStartup(history);
      expect(history.location.href).toBe(href);
      expect(settings.hydrate).not.toHaveBeenCalled();
    },
  );

  it("keeps the original layout's startup unchanged", async () => {
    settings.enabled = false;
    const history = createMemoryHistory({ initialEntries: ["/"] });
    await prepareMemoryStartup(history);
    expect(history.location.pathname).toBe("/");
  });

  it("preserves the alternate layout basepath", async () => {
    settings.enabled = false;
    const history = createMemoryHistory({ initialEntries: ["/layout/"] });
    await prepareMemoryStartup(history);
    expect(history.location.pathname).toBe("/layout/memory");
  });

  it("does not replace navigation that happens while settings hydrate", async () => {
    let finishHydration = () => {};
    settings.hydrate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve;
      }),
    );
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const startup = prepareMemoryStartup(history);
    history.push("/env/thread");
    finishHydration();
    await startup;
    expect(history.location.pathname).toBe("/env/thread");
  });
});
