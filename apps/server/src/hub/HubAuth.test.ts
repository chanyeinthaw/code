import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  AuthOrchestrationOperateScope,
  AuthFilesystemWriteScope,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ServerConfig from "../config.ts";
import * as HubAuth from "./HubAuth.ts";

const layer = Layer.unwrap(
  Effect.gen(function* () {
    return HubAuth.layer(yield* ServerConfig.ServerConfig);
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-auth-" })),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "client links are single-use and read-only sessions cannot mint links or environment invitations",
  () =>
    Effect.gen(function* () {
      const auth = yield* HubAuth.HubAuth;
      const owner = yield* auth.exchange(yield* auth.startup());
      const link = yield* auth.createPairing(owner.token, { role: "read-only", ttlMinutes: 10 });
      const reader = yield* auth.exchange(link.credential);
      expect(reader.scopes).not.toContain(AuthOrchestrationOperateScope);
      expect(reader.scopes).not.toContain(AuthFilesystemWriteScope);
      expect(Exit.isFailure(yield* auth.exchange(link.credential).pipe(Effect.exit))).toBe(true);
      expect(
        Exit.isFailure(
          yield* auth
            .createPairing(reader.token, { role: "admin", ttlMinutes: 10 })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(Exit.isFailure(yield* auth.createInvitation(reader.token).pipe(Effect.exit))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("standard sessions can operate projects while access management remains admin-only", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const standard = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    expect(standard.scopes).toContain(AuthOrchestrationOperateScope);
    expect(standard.scopes).toContain(AuthFilesystemWriteScope);
    expect(Exit.isFailure(yield* auth.access(standard.token).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(
        yield* auth.revoke(standard.token, "session", owner.sessionId).pipe(Effect.exit),
      ),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("machine credentials are bound to one environment and cannot authenticate a client", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const invitation = yield* auth.createInvitation(owner.token, "Worker");
    const input = {
      credential: invitation.credential,
      environmentId: EnvironmentId.make("worker"),
      label: "Worker",
    };
    const machine = yield* auth.enroll(input);
    yield* auth.authenticateEnvironment(machine.token, "worker");
    expect(
      Exit.isFailure(
        yield* auth.authenticateEnvironment(machine.token, "another").pipe(Effect.exit),
      ),
    ).toBe(true);
    expect(Exit.isFailure(yield* auth.authenticate(machine.token).pipe(Effect.exit))).toBe(true);
    expect(Exit.isFailure(yield* auth.enroll(input).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(yield* auth.authenticateEnvironment(owner.token, "worker").pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("revocation invalidates clients and wakes their live connection watchers", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const client = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    const watcher = yield* auth.awaitInvalidation(client.sessionId).pipe(Effect.forkScoped);
    yield* auth.revoke(owner.token, "session", client.sessionId);
    yield* Fiber.join(watcher);
    expect(Exit.isFailure(yield* auth.authenticate(client.token).pipe(Effect.exit))).toBe(true);
    expect(
      Exit.isFailure(yield* auth.revoke(owner.token, "session", owner.sessionId).pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect(
  "an environment can retire only its own enrollment without revoking clients or peers",
  () =>
    Effect.gen(function* () {
      const auth = yield* HubAuth.HubAuth;
      const owner = yield* auth.exchange(yield* auth.startup());
      const worker = yield* auth.enrollLocal("worker", "Worker");
      const other = yield* auth.enrollLocal("other", "Other");
      expect(Exit.isFailure(yield* auth.leave(owner.token, "worker").pipe(Effect.exit))).toBe(true);
      expect(Exit.isFailure(yield* auth.leave(worker.token, "other").pipe(Effect.exit))).toBe(true);
      const watcher = yield* auth.awaitInvalidation(worker.sessionId).pipe(Effect.forkScoped);
      yield* auth.leave(worker.token, "worker");
      yield* Fiber.join(watcher);
      expect(
        Exit.isFailure(
          yield* auth.authenticateEnvironment(worker.token, "worker").pipe(Effect.exit),
        ),
      ).toBe(true);
      yield* auth.authenticateEnvironment(other.token, "other");
      yield* auth.authenticate(owner.token);
      expect((yield* auth.listEnvironments).map((environment) => environment.sessionId)).toEqual([
        other.sessionId,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("active clients renew without changing permissions or revocation identity", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const client = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "read-only", ttlMinutes: 10 })).credential,
    );
    const invalidated = yield* Deferred.make<void>();
    const watcher = yield* auth
      .awaitInvalidation(client.sessionId)
      .pipe(Effect.andThen(Deferred.succeed(invalidated, undefined)), Effect.forkScoped);
    expect((yield* auth.renew(client.token)).token).toBe(client.token);
    yield* TestClock.adjust(Duration.days(8));
    const renewed = yield* auth.renew(client.token);
    const renewedOwner = yield* auth.renew(owner.token);
    expect(renewed.token).not.toBe(client.token);
    expect(renewed.sessionId).toBe(client.sessionId);
    expect(renewed.scopes).toEqual(client.scopes);
    expect(renewed.client).toEqual(client.client);
    const access = yield* auth.access(renewedOwner.token);
    expect(access.clients).toHaveLength(2);
    expect(access.clients.find((entry) => entry.sessionId === client.sessionId)?.expiresAt).toEqual(
      renewed.expiresAt,
    );
    yield* TestClock.adjust(Duration.days(23));
    expect(Exit.isFailure(yield* auth.authenticate(client.token).pipe(Effect.exit))).toBe(true);
    yield* auth.authenticate(renewed.token);
    expect(yield* Deferred.isDone(invalidated)).toBe(false);
    yield* auth.revoke(renewedOwner.token, "session", client.sessionId);
    yield* Fiber.join(watcher);
    expect(Exit.isFailure(yield* auth.renew(renewed.token).pipe(Effect.exit))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("renewal never revives an expired or machine credential", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const client = yield* auth.exchange(yield* auth.startup());
    const machine = yield* auth.enrollLocal("worker", "Worker");
    expect(Exit.isFailure(yield* auth.renew(machine.token).pipe(Effect.exit))).toBe(true);
    yield* TestClock.adjust(Duration.days(31));
    expect(Exit.isFailure(yield* auth.renew(client.token).pipe(Effect.exit))).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("pairing-free clients have admin access only while enabled by an admin", () =>
  Effect.gen(function* () {
    const auth = yield* HubAuth.HubAuth;
    const owner = yield* auth.exchange(yield* auth.startup());
    const standard = yield* auth.exchange(
      (yield* auth.createPairing(owner.token, { role: "standard", ttlMinutes: 10 })).credential,
    );
    expect(yield* auth.clientAccess).toEqual({ requirePairing: true });
    expect(
      Exit.isFailure(yield* auth.openClient({ deviceType: "unknown" }).pipe(Effect.exit)),
    ).toBe(true);
    expect(
      Exit.isFailure(yield* auth.setClientAccess(standard.token, false).pipe(Effect.exit)),
    ).toBe(true);
    yield* auth.setClientAccess(owner.token, false);
    const opened = yield* auth.openClient({ deviceType: "unknown" });
    yield* auth.requireAdmin(opened.token);
    yield* auth.setClientAccess(owner.token, true);
    expect(Exit.isFailure(yield* auth.authenticate(opened.token).pipe(Effect.exit))).toBe(true);
    yield* auth.authenticate(standard.token);
    expect(
      Exit.isFailure(yield* auth.openClient({ deviceType: "unknown" }).pipe(Effect.exit)),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);
