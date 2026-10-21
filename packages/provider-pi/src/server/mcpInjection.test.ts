import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@satslab/contracts";

import {
  SORA_MCP_BEARER_ENV,
  SORA_MCP_URL_ENV,
  SORA_PI_RUNTIME_MODE_ENV,
  SORA_PI_MEMORY_CHAT_ENV,
  SORA_PI_MCP_EXTENSION_PATH_ENV,
} from "./mcpExtensionSource.ts";
import {
  buildPiRpcLaunch,
  piBotLaunchArgs,
  resolvePiLaunchArgs,
  withoutPiPromptResources,
} from "./mcpInjection.ts";

const threadId = ThreadId.make("thread-pi-t3-mcp");

const mcpSession = {
  environmentId: EnvironmentId.make("environment-pi-t3-mcp"),
  threadId,
  providerSessionId: "mcp-session-pi",
  providerInstanceId: ProviderInstanceId.make("pi"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-pi-token",
  browserToolsAvailable: true,
};

describe("pi T3 MCP injection", () => {
  it("keeps native tools and coding instructions for workers with inherited memory", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: { [SORA_PI_MEMORY_CHAT_ENV]: "1" },
      mcpSession: {
        ...mcpSession,
        endpoint: "http://127.0.0.1:43123/bot-mcp",
        botRunId: RunId.make("parent-turn"),
        botThreadId: ThreadId.make("parent"),
      },
      extensionPath: "/tmp/cache/pi-sora-mcp-extension.ts",
    });
    assert.equal(launch.env[SORA_MCP_URL_ENV], "http://127.0.0.1:43123/bot-mcp");
    assert.isUndefined(launch.env[SORA_PI_MEMORY_CHAT_ENV]);
    assert.notInclude(launch.args, "--no-tools");
    assert.notInclude(launch.args, "--no-extensions");
  });

  it("always adds the permission bridge and configures MCP when available", () => {
    const resolvedArgs = resolvePiLaunchArgs(
      "--extension=/home/user/.pi/agent/extensions/demo.ts --session-dir=/tmp/pi-sessions --provider=anthropic --model=claude-sonnet --tools='' --name=-review --extension-flag=kept",
    );
    assert.isTrue(resolvedArgs.ok);
    if (!resolvedArgs.ok) return;
    const launch = buildPiRpcLaunch({
      launchArgs: resolvedArgs.args,
      environment: { PATH: "/usr/bin" },
      mcpSession,
      extensionPath: "/tmp/cache/pi-sora-mcp-extension.ts",
      runtimeMode: "approval-required",
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--extension",
      "/home/user/.pi/agent/extensions/demo.ts",
      "--session-dir",
      "/tmp/pi-sessions",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--tools",
      "",
      "--name",
      "-review",
      "--extension-flag=kept",
      "--extension",
      "/tmp/cache/pi-sora-mcp-extension.ts",
    ]);
    assert.notInclude(launch.args, "--no-extensions");
    assert.equal(launch.env[SORA_MCP_URL_ENV], "http://127.0.0.1:43123/mcp");
    assert.equal(launch.env[SORA_MCP_BEARER_ENV], "secret-pi-token");
    assert.equal(launch.env[SORA_PI_RUNTIME_MODE_ENV], "approval-required");
    assert.equal(launch.env[SORA_PI_MCP_EXTENSION_PATH_ENV], "/tmp/cache/pi-sora-mcp-extension.ts");

    const permissionOnly = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        [SORA_MCP_URL_ENV]: "http://127.0.0.1:9999/stale",
        [SORA_MCP_BEARER_ENV]: "stale-token",
        [SORA_PI_MCP_EXTENSION_PATH_ENV]: "/stale/extension.ts",
      },
      mcpSession: undefined,
      extensionPath: "/tmp/cache/pi-sora-mcp-extension.ts",
      runtimeMode: "auto-accept-edits",
    });
    assert.deepEqual(permissionOnly.args, [
      "--mode",
      "rpc",
      "--extension",
      "/tmp/cache/pi-sora-mcp-extension.ts",
    ]);
    assert.isFalse(permissionOnly.hasT3Mcp);
    assert.isUndefined(permissionOnly.env[SORA_MCP_URL_ENV]);
    assert.isUndefined(permissionOnly.env[SORA_MCP_BEARER_ENV]);
    assert.equal(permissionOnly.env[SORA_PI_RUNTIME_MODE_ENV], "auto-accept-edits");
    assert.equal(
      permissionOnly.env[SORA_PI_MCP_EXTENSION_PATH_ENV],
      "/tmp/cache/pi-sora-mcp-extension.ts",
    );
  });

  it("forces tools and user extensions off for unattended text generation", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [
        "--tools",
        "read,write",
        "--extension",
        "/home/user/.pi/agent/extensions/demo.ts",
        "--extension=./second.ts",
        "--provider",
        "anthropic",
      ],
      environment: {},
      mcpSession,
      extensionPath: "/tmp/cache/pi-sora-mcp-extension.ts",
      sessionPath: "/fake/persisted.jsonl",
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    assert.deepEqual(launch.args, [
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "anthropic",
      "--no-extensions",
      "--no-tools",
    ]);
    assert.isFalse(launch.hasT3Mcp);
    assert.deepInclude(resolvePiLaunchArgs("--mode text"), {
      ok: false,
      message: "Pi launch argument '--mode' is controlled by Sora and cannot be overridden.",
    });
    assert.deepInclude(resolvePiLaunchArgs("--session old.jsonl"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("prompt pi immediately"), { ok: false });
    assert.deepInclude(resolvePiLaunchArgs("--plan @instructions.md"), { ok: false });
  });

  it("rejects --provider without --model, which Pi 1.0 refuses at startup", () => {
    const rejection = {
      ok: false,
      message: "Pi launch argument '--provider' requires '--model'.",
    };
    assert.deepInclude(resolvePiLaunchArgs("--provider openrouter"), rejection);
    assert.deepInclude(resolvePiLaunchArgs("--provider=openrouter --models gpt-6"), rejection);
    assert.isTrue(resolvePiLaunchArgs("--provider openrouter --model=deepseek/v4").ok);
    assert.isTrue(resolvePiLaunchArgs("--model deepseek/v4").ok);
  });
});

it("removes explicit skill and prompt resources while preserving model and authentication options", () => {
  assert.deepEqual(
    withoutPiPromptResources([
      "--skill",
      "/personal/SKILL.md",
      "--skill=/repo/SKILL.md",
      "--system-prompt",
      "personal",
      "--append-system-prompt=personal",
      "--prompt-template",
      "/personal/prompt.md",
      "--provider",
      "custom",
      "--api-key",
      "token",
    ]),
    ["--provider", "custom", "--api-key", "token"],
  );
});

describe("piBotLaunchArgs", () => {
  const launchArgs = [
    "--skill",
    "/mine/SKILL.md",
    "--system-prompt",
    "mine",
    "--provider",
    "custom",
  ];

  it("drops discovery and explicit resources unless the bot loads them", () => {
    assert.deepEqual(piBotLaunchArgs(launchArgs, { loadResources: false, systemPrompt: "bot" }), [
      "--provider",
      "custom",
      "--no-builtin-tools",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--system-prompt",
      "bot",
    ]);
  });

  it("keeps Pi's discovery and explicit resources but always replaces the system prompt", () => {
    assert.deepEqual(piBotLaunchArgs(launchArgs, { loadResources: true, systemPrompt: "bot" }), [
      "--skill",
      "/mine/SKILL.md",
      "--provider",
      "custom",
      "--no-builtin-tools",
      "--system-prompt",
      "bot",
    ]);
  });
});
