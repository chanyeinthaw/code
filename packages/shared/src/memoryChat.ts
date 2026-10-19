import { MEMORY_CHAT_PROVIDER_DRIVERS } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "./semver.ts";

export const MEMORY_CODEX_MINIMUM_VERSION = "0.160.0";

export function memoryCodexDisabledReason(version: string | null) {
  const parsed = version?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
  if (parsed === undefined || parseSemver(parsed) === null)
    return `Memory chat requires Codex ${MEMORY_CODEX_MINIMUM_VERSION} or newer; its version could not be verified.`;
  return compareSemverVersions(parsed, MEMORY_CODEX_MINIMUM_VERSION) < 0
    ? `Memory chat requires Codex ${MEMORY_CODEX_MINIMUM_VERSION} or newer. This instance uses ${parsed}.`
    : null;
}

export function memoryChatProviderDisabledReason(provider: {
  readonly driver: string;
  readonly version: string | null;
}) {
  if (!MEMORY_CHAT_PROVIDER_DRIVERS.has(provider.driver))
    return "This provider does not support memory chat.";
  return provider.driver === "codex" ? memoryCodexDisabledReason(provider.version) : null;
}

// These reserved IDs predate the persisted isMemory flag.
export function isMemoryProject(project: {
  readonly id: string;
  readonly isMemory?: boolean | undefined;
}) {
  return (
    project.isMemory === true ||
    project.id === "one-chat:workspace" ||
    /^agent:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:workspace$/i.test(
      project.id,
    )
  );
}
