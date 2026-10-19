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

import { prepareBotStartup } from "./botStartup";

describe("bot startup navigation", () => {
  beforeEach(() => {
    settings.enabled = true;
    settings.hydrate.mockReset().mockResolvedValue(undefined);
  });

  it("opens bot at startup without changing subsequent navigation to threads", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    await prepareBotStartup(history);
    expect(history.location.pathname).toBe("/bots");
    history.push("/");
    expect(history.location.pathname).toBe("/");
  });

  it.each(["/env/thread", "/bots/env/thread", "/settings/bots", "/draft/draft-1"])(
    "preserves a reload at %s",
    async (href) => {
      const history = createMemoryHistory({ initialEntries: [href] });
      await prepareBotStartup(history);
      expect(history.location.href).toBe(href);
      expect(settings.hydrate).not.toHaveBeenCalled();
    },
  );

  it("keeps the original layout's startup unchanged", async () => {
    settings.enabled = false;
    const history = createMemoryHistory({ initialEntries: ["/"] });
    await prepareBotStartup(history);
    expect(history.location.pathname).toBe("/");
  });

  it("preserves the alternate layout basepath", async () => {
    settings.enabled = false;
    const history = createMemoryHistory({ initialEntries: ["/layout/"] });
    await prepareBotStartup(history);
    expect(history.location.pathname).toBe("/layout/bot");
  });

  it("does not replace navigation that happens while settings hydrate", async () => {
    let finishHydration = () => {};
    settings.hydrate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve;
      }),
    );
    const history = createMemoryHistory({ initialEntries: ["/"] });
    const startup = prepareBotStartup(history);
    history.push("/env/thread");
    finishHydration();
    await startup;
    expect(history.location.pathname).toBe("/env/thread");
  });
});
