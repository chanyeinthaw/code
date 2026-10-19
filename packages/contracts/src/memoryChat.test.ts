import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MemoryId, ThreadId } from "./baseSchemas.ts";
import { selectMemoryIdentities, type MemoryIdentity } from "./memoryChat.ts";

const source: MemoryIdentity = {
  id: MemoryId.make("personal"),
  name: "Personal",
  threadId: ThreadId.make("thread"),
  ownerEnvironmentId: EnvironmentId.make("source"),
  generation: 0,
  status: "active",
  destinationEnvironmentId: null,
};
const staged: MemoryIdentity = {
  ...source,
  generation: 1,
  status: "staged",
  ownerEnvironmentId: EnvironmentId.make("target"),
};
describe("memory identity ownership across environments", () => {
  it("keeps a cancelled transfer's active source selectable despite a newer staged copy", () => {
    expect(selectMemoryIdentities([source, staged])).toEqual([source]);
    expect(selectMemoryIdentities([staged, source])).toEqual([source]);
  });
  it("shows the source during transfer and the new owner after activation", () => {
    const transferring = {
      ...source,
      status: "transferring" as const,
      destinationEnvironmentId: staged.ownerEnvironmentId,
    };
    const forwarded = {
      ...transferring,
      generation: 1,
      status: "forwarded" as const,
      ownerEnvironmentId: staged.ownerEnvironmentId,
    };
    const active = { ...staged, status: "active" as const };
    expect(selectMemoryIdentities([staged, transferring])).toEqual([transferring]);
    expect(selectMemoryIdentities([forwarded, staged])).toEqual([forwarded]);
    expect(selectMemoryIdentities([active, forwarded])).toEqual([active]);
    expect(selectMemoryIdentities([forwarded, active])).toEqual([active]);
  });
  it("keeps an isolated staged copy unavailable and favors the newest returned owner", () => {
    expect(selectMemoryIdentities([staged])).toEqual([staged]);
    const returned = { ...source, generation: 2 };
    expect(selectMemoryIdentities([returned, { ...staged, status: "forwarded" }])).toEqual([
      returned,
    ]);
  });
});

it("keeps a deleted owner's tombstone ahead of stale remote identities", () => {
  const deleted = { ...source, generation: 2, status: "deleted" as const };
  const forwarded = { ...staged, status: "forwarded" as const };
  expect(selectMemoryIdentities([source, forwarded, deleted, staged])).toEqual([deleted]);
  expect(selectMemoryIdentities([deleted, source, staged, forwarded])).toEqual([deleted]);
});
