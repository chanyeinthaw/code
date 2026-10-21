import { scopedThreadKey, scopeThreadRef } from "@satslab/client-runtime/environment";
import { ThreadId } from "@satslab/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  acknowledgeNavigationCompletions,
  resolveNavigationSection,
  resolveNavigationStatus,
} from "./navigation.logic";

const base = makeThreadFixture();
let nextId = 0;
const thread = (overrides: Parameters<typeof makeThreadFixture>[0] = {}) =>
  makeThreadFixture({ id: ThreadId.make(`thread-${nextId++}`), ...overrides });
const runtime = (status: "running" | "completed" | "idle") => ({
  status,
  providerName: "Codex",
  providerInstanceId: base.providerInstanceId,
  activeRunId: null,
  lastError: null,
  updatedAt: base.updatedAt,
});
const idle = () => thread({ runtime: runtime("idle") });
const working = () => thread({ runtime: runtime("running") });
// Running but parked on a thread wait: the one genuine "waiting" the thread row shows.
const waiting = () => thread({ runtime: runtime("running"), blockedOnThreadWait: true });
const input = () => thread({ hasPendingUserInput: true });
const approval = () => thread({ hasPendingApprovals: true });
const finishedAt = "2026-03-09T10:05:00.000Z";
const finished = (lastVisitedAt: string | null) =>
  thread({
    runtime: runtime("completed"),
    latestRun: {
      runId: "run-1" as never,
      status: "completed",
      assistantMessageId: null,
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: finishedAt,
    },
    lastVisitedAt: lastVisitedAt as never,
  });
const key = (t: { environmentId: never; id: never }) =>
  scopedThreadKey(scopeThreadRef(t.environmentId, t.id));
const status = (threads: Parameters<typeof resolveNavigationStatus>[0], acknowledged = {}) =>
  resolveNavigationStatus(threads, acknowledged);

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
  it("is empty without conversations and when nothing is happening", () => {
    expect(status([])).toBeNull();
    expect(status([idle(), idle()])).toBeNull();
    expect(
      status([thread({ runtime: runtime("completed") }), thread({ runtime: null })]),
    ).toBeNull();
    expect(
      status([thread({ runtime: { ...runtime("idle"), status: "failed" as never } })]),
    ).toBeNull();
  });
  it("shows work and clears when work stops", () => {
    const worker = working();
    expect(status([idle(), worker])).toBe("working");
    expect(status([idle(), { ...worker, runtime: runtime("idle") }])).toBeNull();
  });
  it("shows waiting only for a run genuinely blocked on a wait, below working", () => {
    expect(status([idle(), waiting()])).toBe("waiting");
    expect(status([waiting(), working()])).toBe("working");
    expect(status([waiting(), finished("2026-03-09T10:00:00.000Z")])).toBe("done");
    expect(status([{ ...waiting(), runtime: runtime("idle") }])).toBeNull();
  });
  it("prioritizes input, then completion, then work, then waiting regardless of order", () => {
    const done = finished("2026-03-09T10:00:00.000Z");
    expect(status([working(), input(), done, idle()])).toBe("input");
    expect(status([input(), done, working()])).toBe("input");
    expect(status([idle(), working(), done])).toBe("done");
    expect(status([done, working()])).toBe("done");
    expect(status([approval(), working()])).toBe("approval");
    expect(status([approval(), input()])).toBe("input");
    expect(status([approval(), done])).toBe("approval");
  });
  it("ignores deleted and archived conversations", () => {
    expect(
      status([
        { ...input(), deletedAt: idle().updatedAt },
        { ...working(), archivedAt: idle().updatedAt },
      ]),
    ).toBeNull();
  });
  it("only flags completions the thread row would show as unread", () => {
    expect(status([finished(null)])).toBeNull();
    expect(status([finished("2026-03-09T10:06:00.000Z")])).toBeNull();
    expect(status([finished("2026-03-09T10:04:00.000Z")])).toBe("done");
  });
});

describe("navigation acknowledgement", () => {
  it("clears a completion back to the live state without touching ongoing work or input", () => {
    const done = finished("2026-03-09T10:00:00.000Z");
    const threads = [done, working()];
    expect(status(threads)).toBe("done");
    const acknowledged = acknowledgeNavigationCompletions(threads);
    expect(status(threads, acknowledged)).toBe("working");
    expect(status([done, idle()], acknowledged)).toBeNull();
    expect(status([done, waiting()], acknowledged)).toBe("waiting");
    expect(status([done, input(), working()], acknowledged)).toBe("input");
  });
  it("stays acknowledged across rerenders but a newer completion flags again", () => {
    const done = finished("2026-03-09T10:00:00.000Z");
    const acknowledged = acknowledgeNavigationCompletions([done]);
    expect(status([{ ...done }], acknowledged)).toBeNull();
    const rerun = {
      ...done,
      latestRun: { ...done.latestRun!, completedAt: "2026-03-09T10:30:00.000Z" },
    };
    expect(status([rerun], acknowledged)).toBe("done");
  });
  it("records only live, currently unseen completions", () => {
    const done = finished("2026-03-09T10:00:00.000Z");
    const seen = finished("2026-03-09T10:06:00.000Z");
    const archived = { ...finished("2026-03-09T10:00:00.000Z"), archivedAt: done.updatedAt };
    expect(acknowledgeNavigationCompletions([done, seen, archived, working()])).toEqual({
      [key(done as never)]: finishedAt,
    });
  });
});
