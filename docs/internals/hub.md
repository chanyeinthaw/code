# Hub architecture

The hub connects clients to execution environments. Each environment establishes an
outbound connection to one hub. Clients discover that hub's environments and
keep concurrent sessions with them. Execution machines need no public listener;
only the hub needs to be reachable from other machines.

The hub lives in `apps/server` and is distinct from the T3 Connect relay.
Tailscale or a relay can expose its listener without changing environment
routing.

## Ownership and routing

The hub owns connectivity and an in-memory environment catalog. Environments own
projects, provider sessions, threads, files, terminals, and checkpoints. Moving
an environment to another hub preserves its environment identity and local state.

The hub also persists agent configurations and their environment and thread
references. The selected environment owns each agent's conversation and working
directory. Switching hubs preserves environment state but does not migrate the
hub's agent registry. See [OneChat.ts](../../apps/server/src/oneChat/OneChat.ts)
for registry ownership.

Each request identifies its destination through
`/hub/environments/<environmentId>/...`. The hub multiplexes HTTP and WebSocket
traffic through that environment's outbound tunnel. Clients retain this route for
RPC and asset requests; they must not learn direct environment fallback URLs. A
browser-wide machine selection would make concurrent environment sessions
ambiguous.

The catalog retains disconnected entries until the hub restarts or switches to
another hub. It is not a durable machine registry. Revoking an environment blocks its
credential and disconnects its tunnel, but leaves the catalog entry offline.
See [HubServer.ts](../../apps/server/src/hub/HubServer.ts)
for transport ownership and [EnvironmentTunnel.ts](../../apps/server/src/hub/EnvironmentTunnel.ts)
for the environment connection.

## Client origin

The client connects automatically through its own origin. Serving the app over
Tailscale or a network address must not cause its browser to dial localhost.
Electron starts the client, hub, and local environment by default and loads the
client from its installation's HTTP listener. Any client with installation-admin
access can stop or start that installation's environment without restarting the
client or hub. Switching hubs pairs only the client and does not enroll or move
an environment. The execution setting persists in the
installation's Pulse state and overrides its initial CLI or desktop default.
Independently running headless environments keep their own hub connections.
Hub selection and first-run onboarding are bypassed, but an unpaired browser
still needs a hub credential.

A client listener can host a hub or forward hub traffic to a remote hub. The
listener stays available in either mode, keeping the browser's URL stable.
Client-only mode uses the same forwarding path without starting a hub or environment.
See [HubHost.ts](../../apps/server/src/hub/HubHost.ts) for runtime ownership and
[the user guide](../user/remote-access.md#connect-through-a-hub) for CLI modes.

## Public URL behind a proxy

A tunnel can expose the client and hub under a domain while the listener binds
to a local address. `--public-url` declares that external origin for hosting
commands. It controls startup and CLI pairing links without changing the bind
address or the client's connection target. The browser still uses the origin
it opened. Environments have no public client endpoint and use `--hub` for their
outbound connection.

A proxy can rewrite the HTTP Host header while retaining the browser's Origin.
For HTTP mutations and WebSocket upgrades, the hub accepts the configured
public origin or an Origin whose host matches the HTTP Host header. Requests
without Origin still require authentication where the endpoint is protected.
An HTTPS public URL also makes pairing cookies Secure when the proxy forwards
HTTP locally. This keeps access
checks independent of proxy header conventions. See
[authHttp.ts](../../apps/server/src/hub/authHttp.ts) for origin validation.

Service installation persists the hosting command and its public URL across
restarts and updates. DNS, TLS, and WebSocket forwarding belong to the tunnel or
reverse proxy. See [the service guide](../user/background-service.md) for setup.

## Switching hubs

Settings > Hub changes the serving installation's client destination. The listener
keeps its origin and closes active client sockets so clients rediscover the new
hub's environments. The environment keeps its independently saved destination,
including across restarts and execution toggles. Returning the client to the owned
hub uses its existing installation session without additional pairing.
Client-only listeners cannot select an owned hub.

Browser sessions renew through the session endpoint while the client is in use.
Renewal extends the existing session record and signed credential together, preserving
permissions and the session identity used by revocation and live connections.
Expiry watchers re-read the record after their original deadline so renewal does
not close an otherwise valid connection. Expired or revoked credentials cannot renew.

A serving installation can disable client pairing for its owned hub. The client
then obtains an Admin session automatically; environment enrollment still requires
credentials. The opening endpoint is unavailable on transport-only hubs and when
a serving client selects a remote hub. Re-enabling pairing rejects and revokes
sessions issued through that endpoint. This is deployment-wide access, not a trust
check inferred from the browser's network location.

An environment transfer is separate. The current hub's admin authorizes it, and
a destination invitation enrolls the environment. The environment establishes the
new tunnel before retiring its old credential, preserving execution and local
state. Its saved destination overrides the client's selection and the headless
service's original `--hub` flag. Clients remain on their selected hub. Agent
configurations stay with their hub and are not copied during a transfer.

Installation admins can return their bundled environment to its owned hub even
when it no longer appears in the current hub's catalog. This control belongs to
the serving installation and remains reachable through its original origin. The
owned hub still accepts authenticated environment links while its client forwards
to another hub. Returning a stopped environment changes its saved destination;
it does not start execution.

Client switching requires the serving installation's own admin session and a
destination client pairing code. Managing another environment requires admin
access to its current hub. These permissions do not authorize changes to the
destination installation's configuration. Attachment or persistence failures keep
the source connection, but a failed attempt can consume a destination credential.
See [EnvironmentConnection.ts](../../apps/server/src/hub/EnvironmentConnection.ts)
for transfer ownership.

## Authentication

Clients pair with the hub once. The hub owns pairing grants, client sessions,
revocation, and environment enrollment. Hub authentication reuses `EnvironmentAuth`,
`SessionStore`, and `PairingGrantStore` with hub-owned storage. `pulse hub pair` replaces the old
top-level pairing command for this client path. Each environment retains its RPC
scope checks.
Client sessions and machine credentials have separate audiences. A machine
credential is bound to an environment ID and cannot authorize client requests.

Client roles map to scopes across the hub's environments, not per-environment
access lists. Standard clients can operate agents and terminals. Read-only
clients have read scopes. Hub admins can issue pairing links and environment
invitations, move connected environments, and revoke access. The serving installation's startup credential
grants admin access to its own hub.

The hub forwards a verified client principal through the enrolled tunnel. The
environment bridge authenticates loopback requests with a per-launch secret, binding
the principal to the method, path, and expiry. Loopback access alone grants no
execution permissions. Closing a revoked client's hub connections also closes
its downstream streams; already-running agent turns continue.

Hub auth uses a separate state directory and identity. Its Effect storage layer
must be fresh: sharing the environment's persistence layer memoization would make
both runtimes use the same database despite their different configurations.
See [HubAuth.ts](../../apps/server/src/hub/HubAuth.ts).

The client gateway validates browser origins and forwards only destination
hub credentials. Its own local hub session stays on the installation and
continues to authorize hub switching when the destination is unavailable.
Switching never changes the destination hub's configuration.

## Client settings ownership

The Hub page is separate from the original Connections page so upstream syncs
do not have to merge changes to that page. The original route remains available
at `/settings/connections`; the sidebar exposes `/settings/hub-connections`.
Hub-specific components reuse or adapt the existing connection UI.

Disabling an environment changes only this client's connections. It does not
stop the environment or revoke access for other clients. Environment revocation belongs
to the hub and affects every client. See
[HubConnectionsSettings.tsx](../../apps/web/src/components/settings/HubConnectionsSettings.tsx)
for the client boundary.

## Orchestration boundary

Client access to multiple environments does not give a provider session the same
reach. Provider MCP calls use the calling environment's services and projections.
Delegated tasks rely on parent threads and runs in that environment's database.
Forwarding a delegated-task command to another environment would leave its parent
records unresolved. See
[OrchestratorMcpService.ts](../../apps/server/src/mcp/OrchestratorMcpService.ts).

The tunnel currently routes client requests from the hub to an environment. It
has no environment-originated orchestration request or remote task-completion
delivery. Environment enrollment authorizes tunnel connectivity, not permission
to execute agent operations on other environments. Cross-environment orchestration
therefore requires explicit delegated authority and durable links between the
source's parent task and the destination's execution state.

## Current limits

Web and desktop share hub authentication and connection settings. Mobile hub
discovery still needs integration. MCP OAuth remains environment-owned and is
not exposed through hub client sessions. The Copy MCP URL control does not
imply that hub client authentication supports MCP.
