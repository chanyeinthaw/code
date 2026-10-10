import { type OrchestrationV2ThreadShell, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Moving threads to hub environments, as one environment's server does it. */
export function createThreadHandoffEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    options: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-handoff:options",
      tag: WS_METHODS.threadHandoffOptions,
      // Each read probes every hub environment for a matching project.
      staleTimeMs: 15_000,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-handoff:start",
      tag: WS_METHODS.threadHandoffStart,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-handoff:cancel",
      tag: WS_METHODS.threadHandoffCancel,
    }),
  };
}

/** What a thread's banner says about its move, or nothing when there is none to show. */
export function threadHandoffNotice(
  handoff: NonNullable<OrchestrationV2ThreadShell["handoff"]> | null | undefined,
): {
  readonly tone: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string | null;
} | null {
  if (handoff === null || handoff === undefined) return null;
  switch (handoff.state) {
    case "pending":
      return {
        tone: "info",
        title: `Moving to ${handoff.label} when this turn ends`,
        detail: "Send a message to keep it here instead.",
      };
    case "departing":
      return { tone: "info", title: `Moving to ${handoff.label}…`, detail: null };
    case "departed":
      return {
        tone: "info",
        title: `This thread continues on ${handoff.label}`,
        detail: "This copy is read-only.",
      };
    case "failed":
      return {
        tone: "error",
        title: `Could not move to ${handoff.label}`,
        detail: handoff.lastError,
      };
  }
}
