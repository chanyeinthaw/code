import { AuthClientSession, AuthPairingLink } from "./auth.ts";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

/** All environments known to a hub, including those temporarily disconnected. */
export const HubEnvironmentCatalog = Schema.Struct({
  environments: Schema.Array(
    Schema.Struct({
      environmentId: EnvironmentId,
      label: Schema.String,
      connected: Schema.Boolean,
      moveSupported: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type HubEnvironmentCatalog = typeof HubEnvironmentCatalog.Type;

/** A null URL means this installation hosts its own hub. */
export const HubConnection = Schema.Struct({ hubUrl: Schema.NullOr(Schema.String) });
export type HubConnection = typeof HubConnection.Type;

/** Client-only listeners can switch remote hubs but cannot host one. */
export const HubConnectionState = Schema.Struct({
  ...HubConnection.fields,
  localHubAvailable: Schema.Boolean,
  localEnvironmentAvailable: Schema.optionalKey(Schema.Boolean),
  /** Legacy wire field retained for clients installed before the terminology change. */
  localDaemonAvailable: Schema.optionalKey(Schema.Boolean),
});
export type HubConnectionState = typeof HubConnectionState.Type;

/** Execution owned by this serving installation, independent of the selected hub. */
export const HubLocalEnvironmentState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  environmentId: Schema.optionalKey(EnvironmentId),
  label: Schema.optionalKey(Schema.String),
  hubUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type HubLocalEnvironmentState = typeof HubLocalEnvironmentState.Type;
export const HubLocalEnvironmentInput = Schema.Struct({ enabled: Schema.Boolean });
export type HubLocalEnvironmentInput = typeof HubLocalEnvironmentInput.Type;

/** An environment moves independently of clients and needs destination enrollment authority. */
export const HubEnvironmentMoveInput = Schema.Struct({
  ...HubConnection.fields,
  environmentInvitation: Schema.optionalKey(Schema.String),
});
export type HubEnvironmentMoveInput = typeof HubEnvironmentMoveInput.Type;

export const HubAccessRole = Schema.Literals(["read-only", "standard", "admin"]);
export type HubAccessRole = typeof HubAccessRole.Type;
export const HubPairingInput = Schema.Struct({
  role: HubAccessRole,
  label: Schema.optionalKey(Schema.String),
  ttlMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
});
export const HubCredentialInput = Schema.Struct({ credential: Schema.String });
export const HubEnrollmentInput = Schema.Struct({
  credential: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
});
export const HubSwitchInput = Schema.Struct({
  ...HubConnection.fields,
  pairingCode: Schema.optionalKey(Schema.String),
});
export type HubSwitchInput = typeof HubSwitchInput.Type;

export const HubSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  role: Schema.optionalKey(HubAccessRole),
  sessionId: Schema.optionalKey(Schema.String),
});
export type HubSessionState = typeof HubSessionState.Type;

export const HubIssuedCredential = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  expiresAt: Schema.String,
});

const HubEnrolledEnvironment = Schema.Struct({
  sessionId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
});

export const HubAccessSnapshot = Schema.Struct({
  clients: Schema.Array(
    Schema.Struct({
      ...AuthClientSession.fields,
      role: HubAccessRole,
      issuedAt: Schema.DateTimeUtcFromString,
      expiresAt: Schema.DateTimeUtcFromString,
      lastConnectedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    }),
  ),
  environments: Schema.optionalKey(Schema.Array(HubEnrolledEnvironment)),
  /** Legacy wire field retained for existing clients and hubs. */
  daemons: Schema.optionalKey(Schema.Array(HubEnrolledEnvironment)),
  pairingLinks: Schema.Array(
    Schema.Struct({
      ...AuthPairingLink.fields,
      role: HubAccessRole,
      createdAt: Schema.DateTimeUtcFromString,
      expiresAt: Schema.DateTimeUtcFromString,
    }),
  ),
  invitations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optionalKey(Schema.String),
      expiresAt: Schema.String,
    }),
  ),
});
export type HubAccessSnapshot = typeof HubAccessSnapshot.Type;

export const HubClientAccessState = Schema.Struct({ requirePairing: Schema.Boolean });
export type HubClientAccessState = typeof HubClientAccessState.Type;
