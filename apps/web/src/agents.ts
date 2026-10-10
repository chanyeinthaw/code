import { AgentRegistry, type AgentSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeAgents = Schema.decodeUnknownSync(AgentRegistry);
let cachedAgents: typeof AgentRegistry.Type | undefined;

/** The sidebar loads the registry before navigation; mutations refresh the same cache. */
export function getCachedAgents() {
  return cachedAgents;
}

async function cacheResponse(response: Response) {
  const agents = decodeAgents(await response.json());
  cachedAgents = agents;
  return agents;
}

export async function readAgents(signal?: AbortSignal) {
  const response = await fetch("/hub/agents", { signal: signal ?? null });
  if (!response.ok) throw new Error("Could not load agents.");
  return cacheResponse(response);
}

export async function saveAgent(settings: AgentSettings) {
  const response = await fetch("/hub/agents", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error("Could not save agent settings.");
  return cacheResponse(response);
}

export async function removeAgent(id: string) {
  const response = await fetch(`/hub/agents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error("Could not remove agent.");
  return cacheResponse(response);
}

export async function resetAgent(id: string) {
  const response = await fetch(`/hub/agents?id=${encodeURIComponent(id)}`, { method: "POST" });
  if (!response.ok) throw new Error("Could not clear agent configuration.");
  return cacheResponse(response);
}
