import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";

import { environmentCatalog } from "../connection/catalog";
import { Atom } from "effect/reactivity";
import { isAgentProject } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const allEnvironmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
export const environmentProjects = {
  ...allEnvironmentProjects,
  projectsAtom: Atom.map(allEnvironmentProjects.projectsAtom, (projects) =>
    projects.filter((project) => !isAgentProject(project.id)),
  ),
};
export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
});
