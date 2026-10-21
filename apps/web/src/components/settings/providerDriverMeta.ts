import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@satslab/contracts";
import { acpRegistryClient } from "@satslab/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@satslab/provider-core/client";
import { cursorClient } from "@satslab/provider-cursor/client";
import { grokClient } from "@satslab/provider-grok/client";
import { museClient } from "@satslab/provider-muse/client";
import { openCodeClient } from "@satslab/provider-opencode/client";
import { piClient } from "@satslab/provider-pi/client";

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
]);
