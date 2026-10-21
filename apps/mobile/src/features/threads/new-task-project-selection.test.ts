import { EnvironmentId, ProjectId } from "@satslab/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@satslab/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  newTaskDestination,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
} from "./new-task-project-selection";

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/sora",
    title: "Sora",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("sora", "mac", { repositoryKey: "github.com/t3tools/sora" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("sora-clone", "server", { repositoryKey: "github.com/t3tools/sora" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("sora", "mac", { workspaceRoot: "/Users/me/sora" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/sora" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "sora" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("sora", "mac", {
      repositoryKey: "github.com/t3tools/sora",
      workspaceRoot: "/Users/me/sora",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/sora",
      title: "sora",
      workspaceRoot: "/home/me/sora",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/sora" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });
});

describe("resolveDraftProjectSelection", () => {
  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("sora"), makeProject("sora-2"), makeProject("sora-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("sora");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("newTaskDestination", () => {
  it("opens the current thread's project directly in split view", () => {
    const projects = [makeProject("first"), makeProject("current", "other-environment")];
    expect(newTaskDestination(true, projects, projects[1], "request")).toEqual({
      draft: { requestId: "request", environmentId: "other-environment", projectId: "current" },
    });
  });
  it("uses an available project when split view has no current project", () => {
    expect(newTaskDestination(true, [makeProject("first")], undefined, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "first" },
    });
  });
  it("keeps the picker when there are no projects", () => {
    expect(newTaskDestination(true, [], undefined, "request")).toEqual({
      draft: { requestId: "request" },
    });
  });
  it("opens the same draft route in compact view", () => {
    const project = makeProject("current");
    expect(newTaskDestination(false, [project], project, "request")).toEqual({
      draft: { requestId: "request", environmentId: "environment", projectId: "current" },
    });
  });
});
