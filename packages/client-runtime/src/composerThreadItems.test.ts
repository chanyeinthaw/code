import { expect, it } from "vite-plus/test";
import { BotId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { matchComposerThreadItems } from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("local");
const bot = {
  id: ThreadId.make("polaris-thread"),
  botId: BotId.make("polaris"),
  title: "Polaris",
  environmentId,
  archivedAt: null,
  updatedAt: "2026-10-23T00:00:00Z",
};
const ordinary = { ...bot, id: ThreadId.make("ordinary"), botId: undefined, title: "Ordinary" };
const match = (query: string) =>
  matchComposerThreadItems({
    shells: [
      ordinary,
      bot,
      { ...bot, id: ThreadId.make("foreign"), environmentId: EnvironmentId.make("remote") },
    ],
    environmentId,
    excludeThreadId: null,
    query,
  });

it("offers local bots when @ opens and matches their names without case sensitivity", () => {
  expect(match("").map((item) => item.label)).toEqual(["Polaris"]);
  expect(match("pOl")[0]).toMatchObject({
    isBot: true,
    description: "Bot",
    thread: { environmentId, threadId: bot.id },
  });
  expect(match("Ord")[0]).toMatchObject({ description: "Thread", label: "Ordinary" });
});
it("excludes the current bot and archived or deleted bot conversations", () => {
  expect(
    matchComposerThreadItems({
      shells: [
        bot,
        { ...bot, id: ThreadId.make("archived"), archivedAt: bot.updatedAt },
        { ...bot, id: ThreadId.make("deleted"), deletedAt: bot.updatedAt },
      ],
      environmentId,
      excludeThreadId: bot.id,
      query: "Pol",
    }),
  ).toEqual([]);
});
