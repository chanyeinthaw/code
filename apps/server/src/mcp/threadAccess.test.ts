import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@satslab/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { type Caller, readThread, resolveProjectId } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>) =>
  readThread(bareId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("keeps the plain message for an id that matches nothing", () =>
  Effect.gen(function* () {
    const error = yield* readBare([]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe("The thread was not found.");
  }),
);

it.effect("a bot must name the project instead of falling back to its hidden one", () =>
  Effect.gen(function* () {
    const shell = liveThreadShell(bareId);
    const callerFrom = (botRunId: RunId | undefined): Caller => ({
      scope: {
        ...client,
        client: undefined,
        thread: {
          threadId: bareId,
          ...(botRunId === undefined ? {} : { botRunId }),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      },
      // resolveProjectId never reads threads.
      threads: {} as Caller["threads"],
      caller: shell,
      limits: { runtimeMode: "full-access", interactionMode: "default" },
    });

    const bot = yield* resolveProjectId(callerFrom(RunId.make("bot-turn")), undefined).pipe(
      Effect.flip,
    );
    expect(bot.code).toBe("target_required");
    expect(yield* resolveProjectId(callerFrom(undefined), undefined)).toBe(shell.projectId);
  }),
);
