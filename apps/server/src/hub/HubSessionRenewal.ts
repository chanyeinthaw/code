import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode, signPayload } from "../auth/utils.ts";

const Claims = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeClaims = Schema.decodeUnknownEffect(Claims);
const encodeClaims = Schema.encodeEffect(Claims);

/** Extend the same session, preserving its permissions, connected sockets, and revocation identity. */
export const renewHubSession = Effect.fn("HubSessionRenewal.renew")(function* (
  session: SessionStore.VerifiedSession,
) {
  const now = yield* DateTime.now;
  if (
    !session.expiresAt ||
    session.proofKeyThumbprint ||
    session.expiresAt.epochMilliseconds - now.epochMilliseconds >
      Duration.toMillis(Duration.days(29))
  )
    return session;
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const payload = session.token.split(".")[0];
  if (!payload) return session;
  const claims = yield* decodeClaims(base64UrlDecodeUtf8(payload));
  const expiresAt = DateTime.add(now, { days: 30 });
  const updated = yield* sql<{ session_id: string }>`
    UPDATE auth_sessions SET expires_at = ${DateTime.formatIso(expiresAt)}
    WHERE session_id = ${session.sessionId} AND revoked_at IS NULL
    RETURNING session_id
  `;
  if (updated.length === 0) return yield* sessions.verify(session.token);
  const secret = yield* secrets.getOrCreateRandom("server-signing-key", 32);
  const encoded = base64UrlEncode(
    yield* encodeClaims({ ...claims, exp: expiresAt.epochMilliseconds }),
  );
  // Verification after the write also rejects a concurrent revocation.
  return yield* sessions.verify(`${encoded}.${signPayload(encoded, secret)}`);
});
