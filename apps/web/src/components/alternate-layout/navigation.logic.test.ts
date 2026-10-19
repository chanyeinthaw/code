import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import { resolveNavigationSection, resolveNavigationStatus } from "./navigation.logic";

const idle = makeThreadFixture();
const working = makeThreadFixture({
  runtime: {
    status: "running",
    providerName: "Codex",
    providerInstanceId: idle.providerInstanceId,
    activeRunId: null,
    lastError: null,
    updatedAt: idle.updatedAt,
  },
});
const input = makeThreadFixture({ hasPendingUserInput: true });
const approval = makeThreadFixture({ hasPendingApprovals: true });

describe("navigation sidebar origin", () => {
  it.each(["/usage", "/pull-requests", "/layout/usage", "/settings/bots"])(
    "keeps the originating section on %s",
    (path) => {
      expect(resolveNavigationSection(path, "bots")).toBe("bots");
      expect(resolveNavigationSection(path, "threads")).toBe("threads");
    },
  );
  it("updates the origin when switching conversations", () => {
    expect(resolveNavigationSection("/bots/environment/bot", "threads")).toBe("bots");
    expect(resolveNavigationSection("/environment/thread", "bots")).toBe("threads");
    expect(resolveNavigationSection("/", "bots")).toBe("threads");
  });
});

describe("navigation status", () => {
  it("shows work and clears it when work stops", () => {
    expect(resolveNavigationStatus([idle, working])?.label).toBe("Working");
    expect(resolveNavigationStatus([idle])).toBeNull();
    expect(resolveNavigationStatus([])).toBeNull();
  });
  it("prioritizes input and approvals over work regardless of ordering", () => {
    expect(resolveNavigationStatus([working, input])?.label).toBe("Awaiting Input");
    expect(resolveNavigationStatus([input, working])?.label).toBe("Awaiting Input");
    expect(resolveNavigationStatus([working, approval])?.label).toBe("Pending Approval");
    expect(resolveNavigationStatus([approval, input])?.label).toBe("Awaiting Input");
  });
  it("ignores deleted and archived conversations", () => {
    expect(
      resolveNavigationStatus([
        { ...input, deletedAt: idle.updatedAt },
        { ...working, archivedAt: idle.updatedAt },
      ]),
    ).toBeNull();
  });
});
