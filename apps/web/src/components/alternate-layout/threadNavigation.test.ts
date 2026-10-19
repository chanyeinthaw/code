import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, MemoryId } from "@t3tools/contracts";
import { resolveThreadsNavigationHref } from "./threadNavigation";

const environmentId = EnvironmentId.make("environment");
const project = { environmentId, id: ProjectId.make("project") };
const memoryProject = { environmentId, id: ProjectId.make("memory-project"), isMemory: true };
const legacyProject = {
  environmentId,
  id: ProjectId.make("agent:8665b26d-7e56-464f-b935-4a909fe2eaed:workspace"),
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
const memoryThread = {
  ...thread,
  id: ThreadId.make("memory-thread"),
  projectId: memoryProject.id,
  memoryIdentityId: MemoryId.make("memory"),
  updatedAt: "2026-10-21T12:00:00Z",
};
const legacyThread = { ...thread, id: ThreadId.make("legacy-thread"), projectId: legacyProject.id };
const defaults = {
  projects: [project, memoryProject, legacyProject],
  threads: [thread, memoryThread, legacyThread],
  drafts: {
    draft: { environmentId, projectId: project.id, promotedTo: null },
    memory: { environmentId, projectId: memoryProject.id, promotedTo: null },
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
    "/memory/environment/memory-thread",
    "/environment/memory-thread",
    "/draft/memory",
    "/environment/legacy-thread",
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
        threads: [memoryThread, legacyThread],
        rememberedHref: "/environment/legacy-thread",
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
        projects: [memoryProject],
        rememberedHref: "/draft/draft",
      }),
    ).toBe("/");
  });
});
