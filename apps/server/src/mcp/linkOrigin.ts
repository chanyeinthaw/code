import { type OrchestrationV2LinkOrigin } from "@t3tools/contracts";

import type { Caller } from "./threadAccess.ts";

/** The link a caller acts for: its own session, or the link that started its thread. */
export const callerLinkOrigin = (
  caller: Pick<Caller, "scope" | "caller">,
): OrchestrationV2LinkOrigin | undefined =>
  caller.caller?.linkOrigin ??
  (caller.scope.client?.hubEnvironment === true
    ? { sessionId: caller.scope.client.sessionId, label: caller.scope.client.label }
    : undefined);
