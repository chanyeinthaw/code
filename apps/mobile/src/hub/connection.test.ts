import { expect, afterEach, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { MobileSecureStorage } from "../persistence/mobile-secure-storage";
import { make } from "./connection";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

function harness(saved: string | null = null) {
  const values = new Map<string, string>();
  if (saved) values.set("pulse.hub.v1", saved);
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        values.delete(key);
      }),
  });
  return { values, storage };
}

it.effect("pairs once, stores the hub credential securely, and discovers all environments", () => {
  const { values, storage } = harness();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ token: "hub-session", cookieName: "pulse_session" }))
    .mockResolvedValueOnce(
      Response.json({
        environments: [
          { environmentId: "silicon", label: "Silicon", connected: true },
          { environmentId: "oxygen", label: "Oxygen", connected: false },
        ],
      }),
    )
    .mockResolvedValueOnce(Response.json({ ticket: "one-use-ticket" }));
  vi.stubGlobal("fetch", fetch);
  return Effect.gen(function* () {
    const hub = yield* make;
    yield* hub.pair("https://hub.test/#token=pairing-code");
    const entries = yield* Stream.runCollect(Stream.take(hub.registrations, 1));
    const registrations = entries[0]!;
    expect(registrations.map((entry) => entry.target.label)).toEqual(["Silicon", "Oxygen"]);
    expect(registrations[1]!.target.httpBaseUrl).toBe("https://hub.test/hub/environments/oxygen/");
    expect(JSON.stringify(registrations)).not.toContain("hub-session");
    const prepared = yield* hub.prepare(registrations[0]!.target.httpBaseUrl);
    expect(prepared).toEqual({ token: "hub-session", ticket: "one-use-ticket" });
    expect(JSON.parse(values.get("pulse.hub.v1")!)).toMatchObject({
      url: "https://hub.test",
      token: "hub-session",
    });
    const otherHub = yield* Effect.result(
      hub.prepare("https://other.test/hub/environments/oxygen/"),
    );
    expect(otherHub._tag).toBe("Failure");
    yield* hub.disconnect;
    expect(values.get("pulse.hub.v1")).toBe("null");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer hub-session",
    });
    expect(String(fetch.mock.calls[2]?.[0])).toBe(
      "https://hub.test/hub/environments/silicon/api/auth/websocket-ticket",
    );
  }).pipe(Effect.provideService(MobileSecureStorage, storage));
});

it.effect("persists a renewed bearer credential before requesting the environment catalog", () => {
  const { values, storage } = harness(
    JSON.stringify({ url: "https://hub.test", token: "old-session", cookieName: "pulse_session" }),
  );
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        { authenticated: true, role: "standard", sessionId: "session-1" },
        { headers: { "set-cookie": "pulse_session=renewed-session; Path=/; HttpOnly" } },
      ),
    )
    .mockResolvedValueOnce(Response.json({ environments: [] }));
  vi.stubGlobal("fetch", fetch);
  return Effect.gen(function* () {
    const hub = yield* make;
    yield* Stream.runCollect(Stream.take(hub.registrations, 1));
    expect(JSON.parse(values.get("pulse.hub.v1")!).token).toBe("renewed-session");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer renewed-session",
    });
  }).pipe(Effect.provideService(MobileSecureStorage, storage));
});

it.effect("keeps cached environments available after an offline restart", () => {
  const { storage } = harness(
    JSON.stringify({
      url: "https://hub.test",
      token: "saved-session",
      cookieName: "pulse_session",
      catalog: { environments: [{ environmentId: "oxygen", label: "Oxygen", connected: true }] },
    }),
  );
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("offline")));
  return Effect.gen(function* () {
    const hub = yield* make;
    const entries = yield* Stream.runCollect(Stream.take(hub.registrations, 1));
    expect(entries[0]!.map((entry) => entry.target.label)).toEqual(["Oxygen"]);
  }).pipe(Effect.provideService(MobileSecureStorage, storage));
});
