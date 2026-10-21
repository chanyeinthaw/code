import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, BotId } from "@satslab/contracts";
import { resolveThreadsNavigationHref } from "./threadNavigation";

const environmentId = EnvironmentId.make("environment");
const project = { environmentId, id: ProjectId.make("project") };
const botProject = { environmentId, id: ProjectId.make("bot-project"), isBot: true };
const hiddenProject = {
  environmentId,
  id: ProjectId.make("other-bot-project"),
  isBot: true,
};
const thread = {
  id: ThreadId.make("thread"),
  environmentId,
  projectId: project.id,
  lastVisitedAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
};
const botThread = {
  ...thread,
  id: ThreadId.make("bot-thread"),
  projectId: botProject.id,
  botId: BotId.make("bot"),
  updatedAt: "2026-10-21T12:00:00Z",
};
const hiddenThread = { ...thread, id: ThreadId.make("hidden-thread"), projectId: hiddenProject.id };
const defaults = {
  projects: [project, botProject, hiddenProject],
  threads: [thread, botThread, hiddenThread],
  drafts: {
    draft: { environmentId, projectId: project.id, promotedTo: null },
    bot: { environmentId, projectId: botProject.id, promotedTo: null },
  },
};

describe("Threads rail navigation", () => {
  it.each([
    "/environment/thread",
    "/draft/draft",
    "/layout/environment/thread?panel=preview#message",
  ])("restores the last ordinary conversation at %s", (rememberedHref) => {
    expect(resolveThreadsNavigationHref({ ...defaults, rememberedHref })).toBe(rememberedHref);
  });
  it.each([
    null,
    "/bots/environment/bot-thread",
    "/environment/bot-thread",
    "/draft/bot",
    "/environment/hidden-thread",
    "/environment/missing",
    "/%invalid/thread",
    "//other.example/thread",
  ])("falls back to an ordinary thread instead of %s", (rememberedHref) => {
    expect(resolveThreadsNavigationHref({ ...defaults, rememberedHref })).toBe(
      "/environment/thread",
    );
  });
  it("prefers the last visited ordinary thread over one with newer output", () => {
    const recentOutput = {
      ...thread,
      id: ThreadId.make("other"),
      updatedAt: "2026-10-21T14:00:00Z",
      lastVisitedAt: "2026-10-20T00:00:00Z",
    };
    expect(
      resolveThreadsNavigationHref({
        ...defaults,
        threads: [recentOutput, thread],
        rememberedHref: null,
      }),
    ).toBe("/environment/thread");
  });
  it("falls back to normal project selection when no ordinary threads exist", () => {
    expect(
      resolveThreadsNavigationHref({
        ...defaults,
        threads: [botThread, hiddenThread],
        rememberedHref: "/environment/hidden-thread",
      }),
    ).toBe("/");
  });
  it("rejects remembered deleted threads and removed projects", () => {
    expect(
      resolveThreadsNavigationHref({
        ...defaults,
        threads: [{ ...thread, deletedAt: "2026-10-21T01:00:00Z" }],
        rememberedHref: "/environment/thread",
      }),
    ).toBe("/");
    expect(
      resolveThreadsNavigationHref({
        ...defaults,
        projects: [botProject],
        rememberedHref: "/draft/draft",
      }),
    ).toBe("/");
  });
});
