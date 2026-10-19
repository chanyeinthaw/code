import { BOT_CHAT_PROVIDER_DRIVERS } from "@t3tools/contracts";
import { compareSemverVersions, parseSemver } from "./semver.ts";

export const BOT_CODEX_MINIMUM_VERSION = "0.160.0";

export function botCodexDisabledReason(version: string | null) {
  const parsed = version?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?/)?.[0];
  if (parsed === undefined || parseSemver(parsed) === null)
    return `Bots require Codex ${BOT_CODEX_MINIMUM_VERSION} or newer; its version could not be verified.`;
  return compareSemverVersions(parsed, BOT_CODEX_MINIMUM_VERSION) < 0
    ? `Bots require Codex ${BOT_CODEX_MINIMUM_VERSION} or newer. This instance uses ${parsed}.`
    : null;
}

export function botChatProviderDisabledReason(provider: {
  readonly driver: string;
  readonly version: string | null;
}) {
  if (!BOT_CHAT_PROVIDER_DRIVERS.has(provider.driver))
    return "This provider does not support bot chat.";
  return provider.driver === "codex" ? botCodexDisabledReason(provider.version) : null;
}

export function isBotProject(project: {
  readonly id?: string;
  readonly isBot?: boolean | undefined;
}) {
  return project.isBot === true;
}
