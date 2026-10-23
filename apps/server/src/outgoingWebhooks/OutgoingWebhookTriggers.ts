import {
  type OrchestrationV2StoredEvent,
  type OutgoingWebhookEventType,
  type RuntimeRequestId,
  type ThreadId,
} from "@satslab/contracts";
import { resolveThreadAwarenessAlertPhaseV2 } from "@satslab/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@satslab/shared/orchestrationV2PendingBackgroundWork";
import { truncateOutgoingWebhookPreview } from "@satslab/shared/outgoingWebhook";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no synchronous hash, and the id must be derived inside the event transaction.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  makeOutgoingWebhookRepository,
  OUTGOING_WEBHOOK_ALERT_WINDOW,
  type NewOutgoingWebhookJob,
} from "./OutgoingWebhookRepository.ts";

const MAX_TITLE_LENGTH = 500;
/** Bounds what is read from a long message; the largest preview is 4000 characters. */
const MESSAGE_READ_LIMIT = 8000;

/** Stable for a webhook and source event, so a replay or a second evaluation cannot send twice. */
const outgoingWebhookJobId = (webhookId: string, dedupeKey: string) =>
  `whd_${NodeCrypto.createHash("sha256").update(`${webhookId}\u0000${dedupeKey}`).digest("hex").slice(0, 32)}`;

type EventThreads = {
  /** Threads whose alert phase may have changed. */
  readonly threads: Set<ThreadId>;
  /** Requests that turned pending in this batch. A request seen only on a later evaluation is not announced. */
  readonly pendingRequests: Set<RuntimeRequestId>;
};

const collectEventThreads = (events: ReadonlyArray<OrchestrationV2StoredEvent>): EventThreads => {
  const found: EventThreads = { threads: new Set(), pendingRequests: new Set() };
  for (const { event } of events) {
    switch (event.type) {
      case "run.updated":
        if (event.payload.status === "completed" || event.payload.status === "failed") {
          found.threads.add(event.threadId);
        }
        break;
      case "runtime-request.updated":
        if (event.payload.status === "pending") {
          found.threads.add(event.threadId);
          found.pendingRequests.add(event.payload.id);
        }
        break;
      // Background work finishing is what lets a held completion alert.
      case "run.background-work-cancelled":
      case "subagent.updated":
        found.threads.add(event.threadId);
        break;
      case "turn-item.updated":
        if (turnItemUpdateCanEndBackgroundWork(event.payload)) found.threads.add(event.threadId);
        break;
      default:
        break;
    }
  }
  return found;
};

/**
 * Runs inside the transaction that committed `events`, after their projections
 * are applied: the thread shell it reads is the state those events produced.
 * Each alert is one row per subscribed webhook, keyed by the source event
 * (run id, or request id), so the same alert never queues twice. Delivery
 * happens later, in OutgoingWebhookDelivery.
 */
export const makeOutgoingWebhookTriggers = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly projectionStore: Pick<ProjectionStore.ProjectionStoreV2["Service"], "getThreadShell">;
}) => {
  const repository = makeOutgoingWebhookRepository(input.sql);
  // Called for every committed batch, most of them streaming deltas; the enclosing write owns the span.
  return Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
    const { threads, pendingRequests } = collectEventThreads(events);
    if (threads.size === 0) return;
    const webhooks = yield* repository.enabled();
    if (webhooks.length === 0) return;
    const nowDate = yield* DateTime.now;
    const now = DateTime.formatIso(nowDate);
    const staleBefore =
      nowDate.epochMilliseconds - Duration.toMillis(OUTGOING_WEBHOOK_ALERT_WINDOW);
    const jobs: Array<NewOutgoingWebhookJob> = [];
    for (const threadId of threads) {
      const shell = yield* input.projectionStore.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const phase = resolveThreadAwarenessAlertPhaseV2(shell);
      if (phase === null) continue;
      const alert = (() => {
        switch (phase) {
          case "completed":
          case "failed": {
            if (shell.latestRunId === null) return null;
            return {
              eventType: phase satisfies OutgoingWebhookEventType,
              dedupeKey: `${threadId}:${shell.latestRunId}:${phase}`,
              occurredAt: shell.latestRunCompletedAt ?? null,
            };
          }
          case "waiting_for_approval":
          case "waiting_for_input": {
            const request = shell.pendingRuntimeRequest;
            if (request === null || !pendingRequests.has(request.id)) return null;
            return {
              eventType:
                phase === "waiting_for_approval"
                  ? ("approval_required" as const)
                  : ("input_required" as const),
              dedupeKey: `${threadId}:request:${request.id}`,
              occurredAt: request.createdAt,
            };
          }
          case "starting":
          case "running":
          case "stale":
            return null;
        }
      })();
      if (alert === null) continue;
      // Its dedupe record may have been pruned, so a re-evaluated old alert must not send again.
      if (alert.occurredAt !== null && DateTime.toEpochMillis(alert.occurredAt) < staleBefore) {
        continue;
      }
      // The shell carries no message bodies, so read the run's last assistant message directly.
      const rows =
        shell.latestRunId === null
          ? []
          : yield* input.sql<{ readonly text: string | null }>`
              SELECT substr(json_extract(payload_json, '$.text'), 1, ${MESSAGE_READ_LIMIT}) AS text
              FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND run_id = ${shell.latestRunId} AND role = 'assistant'
              ORDER BY created_at DESC, message_id DESC
              LIMIT 1
            `;
      const messageText = rows[0]?.text ?? "";
      for (const webhook of webhooks) {
        if (!webhook.events.includes(alert.eventType)) continue;
        // A completion from before the webhook was switched on is not news to it.
        if (
          webhook.enabledSince !== null &&
          alert.occurredAt !== null &&
          DateTime.toEpochMillis(alert.occurredAt) <
            DateTime.toEpochMillis(DateTime.makeUnsafe(webhook.enabledSince))
        ) {
          continue;
        }
        jobs.push({
          id: outgoingWebhookJobId(webhook.id, alert.dedupeKey),
          webhookId: webhook.id,
          dedupeKey: alert.dedupeKey,
          eventType: alert.eventType,
          context: {
            threadId,
            threadTitle: truncateOutgoingWebhookPreview(shell.title, MAX_TITLE_LENGTH),
            preview: truncateOutgoingWebhookPreview(messageText, webhook.previewLength),
            template: webhook.template,
            clientBaseUrl: webhook.clientBaseUrl,
          },
          nextAttemptAt: nowDate.epochMilliseconds,
          now,
        });
      }
    }
    if (jobs.length > 0) yield* repository.enqueue(jobs);
  });
};
