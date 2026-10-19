import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, BotId, ThreadId } from "./baseSchemas.ts";
import { selectBotIdentities, type BotIdentity } from "./botChat.ts";

const source: BotIdentity = {
  id: BotId.make("personal"),
  name: "Personal",
  threadId: ThreadId.make("thread"),
  ownerEnvironmentId: EnvironmentId.make("source"),
  generation: 0,
  status: "active",
  destinationEnvironmentId: null,
};
const staged: BotIdentity = {
  ...source,
  generation: 1,
  status: "staged",
  ownerEnvironmentId: EnvironmentId.make("target"),
};
describe("memory identity ownership across environments", () => {
  it("keeps a cancelled transfer's active source selectable despite a newer staged copy", () => {
    expect(selectBotIdentities([source, staged])).toEqual([source]);
    expect(selectBotIdentities([staged, source])).toEqual([source]);
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
    expect(selectBotIdentities([staged, transferring])).toEqual([transferring]);
    expect(selectBotIdentities([forwarded, staged])).toEqual([forwarded]);
    expect(selectBotIdentities([active, forwarded])).toEqual([active]);
    expect(selectBotIdentities([forwarded, active])).toEqual([active]);
  });
  it("keeps an isolated staged copy unavailable and favors the newest returned owner", () => {
    expect(selectBotIdentities([staged])).toEqual([staged]);
    const returned = { ...source, generation: 2 };
    expect(selectBotIdentities([returned, { ...staged, status: "forwarded" }])).toEqual([returned]);
  });
});

it("keeps a deleted owner's tombstone ahead of stale remote identities", () => {
  const deleted = { ...source, generation: 2, status: "deleted" as const };
  const forwarded = { ...staged, status: "forwarded" as const };
  expect(selectBotIdentities([source, forwarded, deleted, staged])).toEqual([deleted]);
  expect(selectBotIdentities([deleted, source, staged, forwarded])).toEqual([deleted]);
});
