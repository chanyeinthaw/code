import {
  DEFAULT_OUTGOING_WEBHOOK_PREVIEW_LENGTH,
  DEFAULT_OUTGOING_WEBHOOK_TEMPLATE,
  MAX_OUTGOING_WEBHOOK_HEADERS,
  MAX_OUTGOING_WEBHOOK_PREVIEW_LENGTH,
  OUTGOING_WEBHOOK_EVENT_TYPES,
  type EnvironmentId,
  type OutgoingWebhook,
  type OutgoingWebhookDelivery,
  type OutgoingWebhookEventType,
  type OutgoingWebhookFailureCategory,
  type OutgoingWebhookId,
  type OutgoingWebhookTemplateVariable,
  type OutgoingWebhookUpsertInput,
} from "@satslab/contracts";
import {
  buildOutgoingWebhookNativeThreadUrls,
  buildOutgoingWebhookThreadUrl,
  describeOutgoingWebhookTemplateError,
  OUTGOING_WEBHOOK_SAMPLE_CONTEXT,
  parseOutgoingWebhookClientBaseUrl,
  parseOutgoingWebhookEndpoint,
  parseOutgoingWebhookTemplate,
  renderOutgoingWebhookTemplate,
  truncateOutgoingWebhookPreview,
} from "@satslab/shared/outgoingWebhook";

export interface OutgoingWebhookHeaderDraft {
  /** Stable across edits to the name, for list keys. */
  readonly key: string;
  readonly name: string;
  readonly value: string;
  /** The server holds a value for this header; leaving `value` empty keeps it. */
  readonly stored: boolean;
}

export interface OutgoingWebhookDraft {
  /** Null while creating, including a copy into another environment. */
  readonly id: OutgoingWebhookId | null;
  readonly name: string;
  readonly enabled: boolean;
  readonly events: ReadonlyArray<OutgoingWebhookEventType>;
  readonly template: string;
  readonly previewLength: string;
  readonly clientBaseUrl: string;
  /** Empty keeps the stored endpoint of an existing webhook; a secret endpoint is never filled in. */
  readonly endpoint: string;
  /** Keep the URL in the secret store and hide it, rather than as ordinary readable configuration. */
  readonly secretEndpoint: boolean;
  readonly headers: ReadonlyArray<OutgoingWebhookHeaderDraft>;
}

export const EVENT_LABELS: Record<OutgoingWebhookEventType, string> = {
  completed: "Completed",
  failed: "Failed",
  approval_required: "Approval needed",
  input_required: "Input needed",
};

export const emptyWebhookDraft = (): OutgoingWebhookDraft => ({
  id: null,
  name: "",
  enabled: true,
  events: ["completed"],
  template: DEFAULT_OUTGOING_WEBHOOK_TEMPLATE,
  previewLength: String(DEFAULT_OUTGOING_WEBHOOK_PREVIEW_LENGTH),
  clientBaseUrl: "",
  endpoint: "",
  secretEndpoint: false,
  headers: [],
});

/**
 * A copy carries the settings and the header names, but never secrets: the
 * server never returns them, and the destination needs its own anyway. An
 * ordinary endpoint is configuration, so it is copied with the rest.
 */
export function draftFromWebhook(
  webhook: OutgoingWebhook,
  mode: "edit" | "copy",
): OutgoingWebhookDraft {
  return {
    id: mode === "edit" ? webhook.id : null,
    name: webhook.name,
    enabled: webhook.enabled,
    events: webhook.events,
    template: webhook.template,
    previewLength: String(webhook.previewLength),
    clientBaseUrl: webhook.clientBaseUrl ?? "",
    endpoint: webhook.endpointUrl ?? "",
    secretEndpoint: webhook.secretEndpoint,
    headers: webhook.headerNames.map((name) => ({
      key: `${mode}:${name}`,
      name,
      value: "",
      stored: mode === "edit",
    })),
  };
}

export type DraftResult =
  | { readonly ok: true; readonly input: OutgoingWebhookUpsertInput }
  | { readonly ok: false; readonly message: string };

const fail = (message: string): DraftResult => ({ ok: false, message });

export function draftToUpsertInput(draft: OutgoingWebhookDraft): DraftResult {
  const name = draft.name.trim();
  if (name.length === 0) return fail("Add a name.");
  if (draft.events.length === 0) return fail("Select at least one event.");
  const template = parseOutgoingWebhookTemplate(draft.template);
  if (!template.ok) return fail(describeOutgoingWebhookTemplateError(template.error));
  const previewLength = Number(draft.previewLength);
  if (
    !Number.isInteger(previewLength) ||
    previewLength < 1 ||
    previewLength > MAX_OUTGOING_WEBHOOK_PREVIEW_LENGTH
  ) {
    return fail(`Preview length must be 1 to ${MAX_OUTGOING_WEBHOOK_PREVIEW_LENGTH}.`);
  }
  const clientBaseUrl = draft.clientBaseUrl.trim();
  if (clientBaseUrl.length > 0 && parseOutgoingWebhookClientBaseUrl(clientBaseUrl) === null) {
    return fail("The client URL must be an http or https address.");
  }
  const endpoint = draft.endpoint.trim();
  if (draft.id === null && endpoint.length === 0) return fail("Add the endpoint URL.");
  if (endpoint.length > 0 && parseOutgoingWebhookEndpoint(endpoint) === null) {
    return fail("The endpoint must be an http or https URL.");
  }
  if (draft.headers.length > MAX_OUTGOING_WEBHOOK_HEADERS) {
    return fail(`Use at most ${MAX_OUTGOING_WEBHOOK_HEADERS} headers.`);
  }
  const headers: NonNullable<OutgoingWebhookUpsertInput["headers"]>[number][] = [];
  for (const header of draft.headers) {
    const headerName = header.name.trim();
    if (headerName.length === 0) return fail("Every header needs a name.");
    if (header.value.length === 0 && !header.stored) {
      return fail(`Header ${headerName} needs a value.`);
    }
    headers.push({
      name: headerName,
      ...(header.value.length === 0 ? {} : { value: { value: header.value } }),
    });
  }
  return {
    ok: true,
    input: {
      ...(draft.id === null ? {} : { id: draft.id }),
      name,
      enabled: draft.enabled,
      // Keep the canonical order whatever order they were ticked in.
      events: OUTGOING_WEBHOOK_EVENT_TYPES.filter((type) => draft.events.includes(type)),
      template: draft.template,
      previewLength,
      clientBaseUrl: clientBaseUrl.length === 0 ? null : clientBaseUrl,
      ...(endpoint.length === 0 ? {} : { endpoint: { value: endpoint } }),
      secretEndpoint: draft.secretEndpoint,
      headers,
    },
  };
}

/** Inserts `{{variable}}` over the current selection and reports where the cursor goes next. */
export function insertTemplateVariable(
  template: string,
  selection: { readonly start: number; readonly end: number },
  variable: OutgoingWebhookTemplateVariable,
): { readonly template: string; readonly cursor: number } {
  const token = `{{${variable}}}`;
  return {
    template: `${template.slice(0, selection.start)}${token}${template.slice(selection.end)}`,
    cursor: selection.start + token.length,
  };
}

export type TemplatePreview =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly message: string };

/** The body a recipient would get, using sample content and the draft's own link settings. */
export function previewTemplate(
  draft: Pick<OutgoingWebhookDraft, "template" | "previewLength" | "clientBaseUrl">,
  environmentId: EnvironmentId | null,
): TemplatePreview {
  const parsed = parseOutgoingWebhookTemplate(draft.template);
  if (!parsed.ok) return { ok: false, message: describeOutgoingWebhookTemplateError(parsed.error) };
  const length = Number(draft.previewLength);
  const previewEnvironmentId = environmentId ?? "environment";
  const sample = OUTGOING_WEBHOOK_SAMPLE_CONTEXT;
  const body = renderOutgoingWebhookTemplate(parsed, {
    thread: {
      ...sample.thread,
      url: buildOutgoingWebhookThreadUrl({
        clientBaseUrl: draft.clientBaseUrl.trim() || null,
        environmentId: previewEnvironmentId,
        threadId: sample.thread.id,
      }),
      ...buildOutgoingWebhookNativeThreadUrls({
        environmentId: previewEnvironmentId,
        threadId: sample.thread.id,
      }),
    },
    message: {
      preview: Number.isInteger(length)
        ? truncateOutgoingWebhookPreview(sample.message.preview, Math.max(1, length))
        : sample.message.preview,
    },
    event: { type: "completed" },
  });
  return { ok: true, body: JSON.stringify(JSON.parse(body), null, 2) };
}

/** thread.url renders empty without a client URL, since no origin is assumed. */
export function threadUrlWarning(
  draft: Pick<OutgoingWebhookDraft, "template" | "clientBaseUrl">,
): string | null {
  return draft.template.includes("{{thread.url}}") &&
    parseOutgoingWebhookClientBaseUrl(draft.clientBaseUrl.trim() || null) === null
    ? "{{thread.url}} is empty until a client URL is set."
    : null;
}

const FAILURE_LABELS: Record<OutgoingWebhookFailureCategory, string> = {
  network: "Network error",
  timeout: "Timed out",
  rate_limited: "Rate limited",
  server_error: "Server error",
  rejected: "Rejected",
  secret_missing: "Missing endpoint or header",
  template_invalid: "Invalid template",
  payload_too_large: "Body too large",
};

export function deliveryLabel(
  delivery: Pick<OutgoingWebhookDelivery, "status" | "failure" | "httpStatus" | "attempts">,
): string {
  const http = delivery.httpStatus === null ? "" : ` (${delivery.httpStatus})`;
  switch (delivery.status) {
    case "succeeded":
      return `Sent${http}`;
    case "failed":
      return `${delivery.failure === null ? "Failed" : FAILURE_LABELS[delivery.failure]}${http}`;
    case "queued":
      return delivery.attempts > 0 && delivery.failure !== null
        ? `Retrying: ${FAILURE_LABELS[delivery.failure]}${http}`
        : "Queued";
    case "sending":
      return "Sending";
    case "cancelled":
      return "Cancelled";
  }
}

export function deliveryVariant(status: OutgoingWebhookDelivery["status"]) {
  return status === "succeeded"
    ? "success"
    : status === "failed"
      ? "error"
      : status === "cancelled"
        ? "outline"
        : "warning";
}
