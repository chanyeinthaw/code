import { HubEnvironmentCatalog, HubSessionState } from "@t3tools/contracts";
import {
  HubConnectionRegistration,
  HubConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { parsePairingUrl } from "../features/connection/pairing";

const SavedHub = Schema.Struct({
  url: Schema.String,
  token: Schema.String,
  cookieName: Schema.String,
  catalog: Schema.optionalKey(HubEnvironmentCatalog),
});
const SavedHubJson = Schema.fromJsonString(Schema.NullOr(SavedHub));
const decodeSaved = Schema.decodeUnknownEffect(SavedHubJson);
const encodeSaved = Schema.encodeEffect(SavedHubJson);
const PairResponse = Schema.Struct({ token: Schema.String, cookieName: Schema.String });
const TicketResponse = Schema.Struct({ ticket: Schema.String });
const SessionResponse = Schema.Struct({
  ...HubSessionState.fields,
  token: Schema.optionalKey(Schema.String),
});
const decodePair = Schema.decodeUnknownEffect(PairResponse);
const decodeTicket = Schema.decodeUnknownEffect(TicketResponse);
const decodeSession = Schema.decodeUnknownEffect(SessionResponse);
const decodeCatalog = Schema.decodeUnknownEffect(HubEnvironmentCatalog);
const STORAGE_KEY = "pulse.hub.v1";

function unavailable(cause: unknown) {
  return new ConnectionTransientError({
    reason: "network",
    detail: cause instanceof Error ? cause.message : "Hub unavailable.",
  });
}

function registrationsForHub(url: string, catalog: HubEnvironmentCatalog) {
  return catalog.environments.map((environment) => {
    const httpBaseUrl = `${url}/hub/environments/${encodeURIComponent(environment.environmentId)}/`;
    const socket = new URL(httpBaseUrl);
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    return new HubConnectionRegistration({
      target: new HubConnectionTarget({
        environmentId: environment.environmentId,
        label: environment.label,
        httpBaseUrl,
        wsBaseUrl: socket.toString(),
      }),
    });
  });
}

export const make = Effect.gen(function* () {
  const storage = yield* MobileSecureStorage;
  const raw = yield* storage.getItem(STORAGE_KEY);
  const initial =
    raw === null ? null : yield* decodeSaved(raw).pipe(Effect.catch(() => Effect.succeed(null)));
  const state = yield* SubscriptionRef.make(initial);
  const lastCatalog = yield* Ref.make<ReadonlyArray<HubConnectionRegistration>>(
    initial?.catalog ? registrationsForHub(initial.url, initial.catalog) : [],
  );
  const renewedAt = yield* Ref.make<number | null>(null);
  const persist = Effect.fn("mobile.hub.persist")(function* (hub: typeof SavedHub.Type | null) {
    yield* storage.setItem(STORAGE_KEY, yield* encodeSaved(hub));
    yield* Ref.set(lastCatalog, []);
    yield* SubscriptionRef.set(state, hub);
  });
  const request = Effect.fn("mobile.hub.request")(function* (
    hub: typeof SavedHub.Type,
    path: string,
    init?: RequestInit,
  ) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(new URL(path, hub.url), {
          ...init,
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${hub.token}`,
            ...init?.headers,
          },
        }),
      catch: () => unavailable("Hub unavailable."),
    });
    if (response.status === 401 || response.status === 403) {
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: "Pair with this hub again in Connections.",
      });
    }
    if (!response.ok) return yield* unavailable("Hub unavailable.");
    const body: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: unavailable,
    });
    // React Native exposes Set-Cookie; persist renewed credentials rather than relying on its cookie jar.
    if (path === "/hub/auth/session" && body !== null && typeof body === "object") {
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      const token = cookie?.startsWith(`${hub.cookieName}=`)
        ? cookie.slice(hub.cookieName.length + 1)
        : undefined;
      return { ...body, ...(token ? { token } : {}) };
    }
    return body;
  });
  const pair = Effect.fn("mobile.hub.pair")(function* (pairingUrl: string) {
    const { host, code } = parsePairingUrl(pairingUrl);
    const url = yield* Effect.try({
      try: () => new URL(host.includes("://") ? host : `https://${host}`),
      catch: () =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "Enter a valid hub address.",
        }),
    });
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !code) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: "Enter a hub address and pairing code.",
      });
    }
    const hub = { url: url.origin, token: "", cookieName: "" };
    const paired = yield* decodePair(
      yield* request(hub, "/hub/auth/pair", {
        method: "POST",
        body: JSON.stringify({ credential: code }),
      }),
    ).pipe(Effect.mapError(unavailable));
    yield* persist({ ...hub, token: paired.token, cookieName: paired.cookieName });
    yield* Ref.set(renewedAt, yield* Clock.currentTimeMillis);
  });
  const discover = Effect.fn("mobile.hub.discover")(function* (hub: typeof SavedHub.Type | null) {
    if (!hub) return [];
    const lastRenewal = yield* Ref.get(renewedAt);
    const now = yield* Clock.currentTimeMillis;
    if (lastRenewal === null || now - lastRenewal >= 60 * 60 * 1000) {
      const session = yield* decodeSession(yield* request(hub, "/hub/auth/session")).pipe(
        Effect.mapError(unavailable),
      );
      if (!session.authenticated)
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "Pair with this hub again in Connections.",
        });
      if (session.token && session.token !== hub.token) {
        hub = { ...hub, token: session.token };
        yield* storage.setItem(STORAGE_KEY, yield* encodeSaved(hub));
        yield* SubscriptionRef.set(state, hub);
      }
      yield* Ref.set(renewedAt, yield* Clock.currentTimeMillis);
    }
    const catalog = yield* decodeCatalog(yield* request(hub, "/hub/environments")).pipe(
      Effect.mapError(unavailable),
    );
    const registrations = registrationsForHub(hub.url, catalog);
    if (JSON.stringify(hub.catalog) !== JSON.stringify(catalog)) {
      hub = { ...hub, catalog };
      yield* storage.setItem(STORAGE_KEY, yield* encodeSaved(hub));
      yield* SubscriptionRef.set(state, hub);
    }
    yield* Ref.set(lastCatalog, registrations);
    return registrations;
  });
  const prepare = Effect.fn("mobile.hub.prepare")(function* (httpBaseUrl: string) {
    const hub = yield* SubscriptionRef.get(state);
    if (!hub || new URL(httpBaseUrl).origin !== hub.url)
      return yield* new ConnectionBlockedError({
        reason: "authentication",
        detail: "This environment belongs to another hub.",
      });
    const ticket = yield* decodeTicket(
      yield* request(hub, new URL("api/auth/websocket-ticket", httpBaseUrl).pathname, {
        method: "POST",
      }),
    ).pipe(Effect.mapError(unavailable));
    return { token: hub.token, ticket: ticket.ticket };
  });
  return {
    pair,
    disconnect: persist(null),
    urls: SubscriptionRef.changes(state).pipe(Stream.map((hub) => hub?.url ?? null)),
    prepare,
    registrations: Stream.merge(
      SubscriptionRef.changes(state),
      Stream.tick("5 seconds").pipe(Stream.mapEffect(() => SubscriptionRef.get(state))),
    ).pipe(Stream.mapEffect((hub) => discover(hub).pipe(Effect.catch(() => Ref.get(lastCatalog))))),
  };
});

export class HubConnection extends Context.Service<HubConnection, Effect.Success<typeof make>>()(
  "pulse.mobile.HubConnection",
) {}
export const layer = Layer.effect(HubConnection, make);
