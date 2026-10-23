import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_BOT_DISCORD_SETTINGS } from "@satslab/contracts";
import { acceptsMessage } from "./DiscordPolicy.ts";
import type { DiscordMessage } from "./model.ts";

const message: DiscordMessage = {
  id: "1",
  channelId: "2",
  guildId: "3",
  inThread: false,
  authorId: "4",
  authorName: "Chan",
  authorIsBot: false,
  webhook: false,
  system: false,
  mentionsBot: false,
  referenceId: null,
  text: "hello",
  attachments: [],
};
const settings = { ...DEFAULT_BOT_DISCORD_SETTINGS, enabled: true };

describe("Discord input policy", () => {
  it("requires mentions for independent messages but accepts known reply chains", () => {
    expect(acceptsMessage(settings, message, false)).toBe(false);
    expect(acceptsMessage(settings, { ...message, mentionsBot: true }, false)).toBe(true);
    expect(acceptsMessage(settings, message, true)).toBe(true);
    expect(acceptsMessage({ ...settings, interactionMode: "all-messages" }, message, false)).toBe(
      true,
    );
  });
  it("applies user filtering to follow-ups, with permissive empty lists", () => {
    for (const mode of ["allow", "block"] as const) {
      expect(
        acceptsMessage({ ...settings, userPolicy: { mode, userIds: [] } }, message, true),
      ).toBe(true);
    }
    expect(
      acceptsMessage({ ...settings, userPolicy: { mode: "allow", userIds: ["5"] } }, message, true),
    ).toBe(false);
    expect(
      acceptsMessage({ ...settings, userPolicy: { mode: "allow", userIds: ["4"] } }, message, true),
    ).toBe(true);
    expect(
      acceptsMessage({ ...settings, userPolicy: { mode: "block", userIds: ["4"] } }, message, true),
    ).toBe(false);
  });
  it("ignores DMs, bots, webhooks, system messages, and disabled integrations", () => {
    for (const patch of [
      { guildId: null },
      { authorIsBot: true },
      { webhook: true },
      { system: true },
    ]) {
      expect(acceptsMessage(settings, { ...message, ...patch, mentionsBot: true }, true)).toBe(
        false,
      );
    }
    expect(acceptsMessage({ ...settings, enabled: false }, message, true)).toBe(false);
  });
});
