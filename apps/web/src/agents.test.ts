import { AgentSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { getCachedAgents, readAgents, saveAgent } from "./agents";

const decodeAgentSettings = Schema.decodeUnknownSync(AgentSettings);

afterEach(() => vi.unstubAllGlobals());

it("keeps agent configuration available during a pending refresh and updates it after saving", async () => {
  const configuration = {
    environmentId: "environment-1",
    threadId: "agent:pulse:conversation",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    additionalInstructions: "",
  };
  const initial = [{ id: "pulse", name: "Pulse", configuration }];
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json(initial));
  vi.stubGlobal("fetch", fetch);
  await readAgents();

  let finishRefresh: (response: Response) => void = () => {};
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
  );
  const refresh = readAgents();
  expect(getCachedAgents()).toEqual(initial);
  finishRefresh(Response.json(initial));
  await refresh;

  const renamed = [{ ...initial[0], name: "Assistant" }];
  fetch.mockResolvedValueOnce(Response.json(renamed));
  await saveAgent(
    decodeAgentSettings({
      id: "pulse",
      name: "Assistant",
      ...configuration,
    }),
  );
  expect(getCachedAgents()).toEqual(renamed);
});
