import { EnvironmentId, ProjectId, type ServerConfig } from "@satslab/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import { v2Project, v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("local");
const remoteEnvironmentId = EnvironmentId.make("remote");

function makeHarness(withConfig = true) {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make({
      ...v2ShellSnapshot,
      projects: [
        { ...v2Project, title: "No project" },
        {
          ...v2Project,
          title: "No project",
          id: ProjectId.make("ordinary"),
          workspaceRoot: "/repo",
        },
      ],
    }),
  );
  const configAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<(Pick<ServerConfig, "scratchWorkspaceRoot"> & { revision?: number }) | null>(null),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      [environmentId, remoteEnvironmentId].map((id) => [
        id,
        {
          target: new PrimaryConnectionTarget({
            environmentId: id,
            label: id,
            httpBaseUrl: `https://${id}.example.test`,
            wsBaseUrl: `wss://${id}.example.test`,
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  });
  const projects = createEnvironmentProjectAtoms({
    catalogValueAtom,
    snapshotAtom,
    ...(withConfig ? { serverConfigValueAtom: configAtom } : {}),
  });
  return { registry: AtomRegistry.make(), projects, configAtom, snapshotAtom, catalogValueAtom };
}

describe("project scratch identity", () => {
  it("waits for enabled project configs and ignores a disabled environment with no config", () => {
    const { registry, projects, configAtom, catalogValueAtom } = makeHarness();
    try {
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      registry.set(configAtom(environmentId), { scratchWorkspaceRoot: v2Project.workspaceRoot });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      const catalog = registry.get(catalogValueAtom);
      registry.set(catalogValueAtom, {
        ...catalog,
        entries: new Map(
          [...catalog.entries].map(([id, entry]) => [
            id,
            { ...entry, enabled: id === environmentId },
          ]),
        ),
      });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(true);
      registry.set(catalogValueAtom, catalog);
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
      registry.set(configAtom(remoteEnvironmentId), {});
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(true);
      registry.set(catalogValueAtom, { ...catalog, isReady: false });
      expect(registry.get(projects.projectConfigsReadyAtom)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it("updates a loaded project when config arrives, preserving unrelated projects and snapshots", () => {
    const { registry, projects, configAtom, snapshotAtom } = makeHarness();
    try {
      const initial = registry.get(projects.projectsAtom);
      const source = registry.get(snapshotAtom(environmentId));
      registry.set(configAtom(environmentId), {
        scratchWorkspaceRoot: `${v2Project.workspaceRoot}/`,
      });
      const next = registry.get(projects.projectsAtom);

      expect(next[0]?.isScratch).toBe(true);
      expect(next[0]).not.toBe(initial[0]);
      expect(next.slice(1)).toEqual(initial.slice(1));
      for (let index = 1; index < initial.length; index++) {
        expect(next[index]).toBe(initial[index]);
      }
      expect(registry.get(snapshotAtom(environmentId))).toBe(source);
      expect(v2Project).not.toHaveProperty("isScratch");

      registry.set(configAtom(environmentId), {
        scratchWorkspaceRoot: v2Project.workspaceRoot,
        revision: 1,
      });
      expect(registry.get(projects.projectsAtom)).toBe(next);

      registry.set(configAtom(environmentId), { scratchWorkspaceRoot: "/repo" });
      const changedRoot = registry.get(projects.projectsAtom);
      expect(changedRoot[0]).not.toHaveProperty("isScratch");
      expect(changedRoot[1]?.isScratch).toBe(true);
      expect(changedRoot[2]).toBe(initial[2]);

      registry.set(configAtom(environmentId), null);
      expect(registry.get(projects.projectsAtom).every((project) => !project.isScratch)).toBe(true);
    } finally {
      registry.dispose();
    }
  });
});

it("hides memory projects from pickers while keeping direct project lookup", () => {
  const { registry, projects, snapshotAtom } = makeHarness();
  try {
    const source = registry.get(snapshotAtom(environmentId));
    registry.set(snapshotAtom(environmentId), {
      ...source,
      projects: source.projects.map((project) =>
        project.id === v2Project.id ? { ...project, isBot: true } : project,
      ),
    });
    expect(
      registry
        .get(projects.projectsAtom)
        .filter((project) => project.environmentId === environmentId)
        .map((project) => project.id),
    ).toEqual([ProjectId.make("ordinary")]);
    const memory = registry.get(projects.projectAtom({ environmentId, projectId: v2Project.id }));
    expect(memory?.isBot).toBe(true);
    expect(registry.get(projects.allProjectsAtom)).toContain(memory);
    const visibleProjects = registry.get(projects.projectsAtom);
    const current = registry.get(snapshotAtom(environmentId));
    registry.set(snapshotAtom(environmentId), {
      ...current,
      projects: current.projects.map((project) =>
        project.id === v2Project.id ? { ...project, title: "Renamed memory" } : project,
      ),
    });
    expect(
      registry.get(projects.allProjectsAtom).find((project) => project.id === v2Project.id)?.title,
    ).toBe("Renamed memory");
    expect(registry.get(projects.projectsAtom)).toBe(visibleProjects);
  } finally {
    registry.dispose();
  }
});

it("keeps unflagged agent workspaces in ordinary project fallbacks", () => {
  const { registry, projects, snapshotAtom } = makeHarness();
  try {
    const source = registry.get(snapshotAtom(environmentId));
    const legacyId = ProjectId.make("agent:8665b26d-7e56-464f-b935-4a909fe2eaed:workspace");
    registry.set(snapshotAtom(environmentId), {
      ...source,
      projects: [{ ...v2Project, id: legacyId }, ...source.projects],
    });
    expect(registry.get(projects.projectsAtom).some((project) => project.id === legacyId)).toBe(
      true,
    );
    expect(registry.get(projects.projectAtom({ environmentId, projectId: legacyId }))?.id).toBe(
      legacyId,
    );
  } finally {
    registry.dispose();
  }
});
