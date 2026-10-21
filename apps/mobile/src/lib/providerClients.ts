import { isProviderDriverKind } from "@satslab/contracts";
import { acpRegistryClient } from "@satslab/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@satslab/provider-core/client";
import { cursorClient } from "@satslab/provider-cursor/client";
import { grokClient } from "@satslab/provider-grok/client";
import { museClient } from "@satslab/provider-muse/client";
import { openCodeClient } from "@satslab/provider-opencode/client";
import { piClient } from "@satslab/provider-pi/client";

const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
