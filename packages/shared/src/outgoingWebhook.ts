import {
  MAX_OUTGOING_WEBHOOK_BODY_BYTES,
  MAX_OUTGOING_WEBHOOK_SECRET_LENGTH,
  OUTGOING_WEBHOOK_TEMPLATE_VARIABLES,
  type OutgoingWebhookDeliveryEventType,
  type OutgoingWebhookTemplateVariable,
} from "@satslab/contracts";

import { buildAgentAwarenessDeepLink } from "./agentAwareness.ts";

/** Values a template can reference. Captured when the event commits, so a retry renders the same body. */
export interface OutgoingWebhookTemplateContext {
  readonly thread: {
    readonly id: string;
    readonly title: string;
    /** The HTTP link built from the webhook's client URL; empty without one. */
    readonly url: string;
    /** Opens the Sora app, independent of any client URL. */
    readonly soraUrl: string;
    /** Opens the app under its t3code scheme, independent of any client URL. */
    readonly t3codeUrl: string;
  };
  readonly message: { readonly preview: string };
  readonly event: { readonly type: OutgoingWebhookDeliveryEventType };
}

type TextPart = string | { readonly variable: OutgoingWebhookTemplateVariable };

type TemplateNode =
  | { readonly type: "text"; readonly parts: ReadonlyArray<TextPart> }
  | { readonly type: "literal"; readonly value: number | boolean | null }
  | { readonly type: "array"; readonly items: ReadonlyArray<TemplateNode> }
  | {
      readonly type: "object";
      readonly entries: ReadonlyArray<readonly [key: string, value: TemplateNode]>;
    };

export type OutgoingWebhookTemplateError =
  | { readonly kind: "invalid_json" }
  | { readonly kind: "not_container" }
  | { readonly kind: "unknown_variable"; readonly variable: string }
  | { readonly kind: "placeholder_in_key" }
  | { readonly kind: "unmatched_braces" };

export type ParsedOutgoingWebhookTemplate =
  | { readonly ok: true; readonly node: TemplateNode }
  | { readonly ok: false; readonly error: OutgoingWebhookTemplateError };

export function describeOutgoingWebhookTemplateError(error: OutgoingWebhookTemplateError): string {
  switch (error.kind) {
    case "invalid_json":
      return "The template must be valid JSON. Put {{variables}} inside string values.";
    case "not_container":
      return "The template must be a JSON object or array.";
    case "unknown_variable":
      return `Unknown variable {{${error.variable}}}. Use ${OUTGOING_WEBHOOK_TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(", ")}.`;
    case "placeholder_in_key":
      return "Variables can only appear in string values, not in keys.";
    case "unmatched_braces":
      return "A string has {{ or }} that is not part of a {{variable}}.";
  }
}

const VARIABLE_NAMES: ReadonlySet<string> = new Set(OUTGOING_WEBHOOK_TEMPLATE_VARIABLES);
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

const splitText = (text: string): ReadonlyArray<TextPart> | OutgoingWebhookTemplateError => {
  const parts: Array<TextPart> = [];
  let cursor = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? "";
    if (!VARIABLE_NAMES.has(name)) return { kind: "unknown_variable", variable: name };
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push({ variable: name as OutgoingWebhookTemplateVariable });
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest.includes("{{") || rest.includes("}}")) return { kind: "unmatched_braces" };
  if (rest.length > 0) parts.push(rest);
  return parts;
};

const isError = (value: unknown): value is OutgoingWebhookTemplateError =>
  typeof value === "object" && value !== null && "kind" in value;

const compile = (value: unknown): TemplateNode | OutgoingWebhookTemplateError => {
  if (typeof value === "string") {
    const parts = splitText(value);
    return isError(parts) ? parts : { type: "text", parts };
  }
  if (Array.isArray(value)) {
    const items: Array<TemplateNode> = [];
    for (const item of value) {
      const node = compile(item);
      if (isError(node)) return node;
      items.push(node);
    }
    return { type: "array", items };
  }
  if (typeof value === "object" && value !== null) {
    const entries: Array<readonly [string, TemplateNode]> = [];
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("{{") || key.includes("}}")) return { kind: "placeholder_in_key" };
      const node = compile(item);
      if (isError(node)) return node;
      entries.push([key, node]);
    }
    return { type: "object", entries };
  }
  return { type: "literal", value: value as number | boolean | null };
};

/**
 * Parses the JSON first and substitutes only inside string values, so a title
 * with quotes or newlines can never break the body's structure.
 */
export function parseOutgoingWebhookTemplate(template: string): ParsedOutgoingWebhookTemplate {
  let json: unknown;
  try {
    json = JSON.parse(template);
  } catch {
    return { ok: false, error: { kind: "invalid_json" } };
  }
  if (typeof json !== "object" || json === null) {
    return { ok: false, error: { kind: "not_container" } };
  }
  const node = compile(json);
  return isError(node) ? { ok: false, error: node } : { ok: true, node };
}

const EVENT_EMOJI: Readonly<Record<OutgoingWebhookDeliveryEventType, string>> = {
  completed: "✅",
  failed: "❌",
  approval_required: "✋",
  input_required: "💬",
  test: "🧪",
};

const variableValue = (
  context: OutgoingWebhookTemplateContext,
  variable: OutgoingWebhookTemplateVariable,
): string => {
  switch (variable) {
    case "thread.id":
      return context.thread.id;
    case "thread.title":
      return context.thread.title;
    case "thread.url":
      return context.thread.url;
    case "thread.soraUrl":
      return context.thread.soraUrl;
    case "thread.t3codeUrl":
      return context.thread.t3codeUrl;
    case "message.preview":
      return context.message.preview;
    case "event.type":
      return context.event.type;
    case "event.emoji":
      return EVENT_EMOJI[context.event.type];
  }
};

const materialize = (node: TemplateNode, context: OutgoingWebhookTemplateContext): unknown => {
  switch (node.type) {
    case "text":
      return node.parts
        .map((part) => (typeof part === "string" ? part : variableValue(context, part.variable)))
        .join("");
    case "literal":
      return node.value;
    case "array":
      return node.items.map((item) => materialize(item, context));
    case "object":
      return Object.fromEntries(
        node.entries.map(([key, item]) => [key, materialize(item, context)]),
      );
  }
};

export function renderOutgoingWebhookTemplate(
  template: Extract<ParsedOutgoingWebhookTemplate, { ok: true }>,
  context: OutgoingWebhookTemplateContext,
): string {
  return JSON.stringify(materialize(template.node, context));
}

export const outgoingWebhookBodyTooLarge = (body: string): boolean =>
  new TextEncoder().encode(body).length > MAX_OUTGOING_WEBHOOK_BODY_BYTES;

/** Sample values for the editor preview and the Test action. */
export const OUTGOING_WEBHOOK_SAMPLE_CONTEXT = {
  thread: { id: "thread-sample", title: "Fix the login redirect" },
  message: { preview: "Done. The redirect now keeps the original path." },
  event: { type: "test" },
} as const satisfies Omit<OutgoingWebhookTemplateContext, "thread"> & {
  readonly thread: Pick<OutgoingWebhookTemplateContext["thread"], "id" | "title">;
};

/** Cuts on code points so an emoji or other surrogate pair is never split. */
export function truncateOutgoingWebhookPreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxLength) return normalized;
  return `${characters
    .slice(0, Math.max(0, maxLength - 1))
    .join("")
    .trimEnd()}…`;
}

/**
 * The web client's thread route is `/<environmentId>/<threadId>` on whatever
 * origin serves it. No origin is assumed: without a configured base the
 * variable is empty, since a guessed host may not know this environment.
 */
export function buildOutgoingWebhookThreadUrl(input: {
  readonly clientBaseUrl: string | null;
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  const base = parseOutgoingWebhookClientBaseUrl(input.clientBaseUrl);
  if (base === null) return "";
  return `${base}/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

/**
 * Deep links into the installed apps, `<scheme>://threads/<environment>/<thread>`,
 * the shape the apps already route. They need no client URL, since the OS picks
 * the app by scheme.
 */
export function buildOutgoingWebhookNativeThreadUrls(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): { readonly soraUrl: string; readonly t3codeUrl: string } {
  const route = buildAgentAwarenessDeepLink(input).slice(1);
  return { soraUrl: `sora://${route}`, t3codeUrl: `t3code://${route}` };
}

/** The normalized http(s) base without a trailing slash, or null when absent or invalid. */
export function parseOutgoingWebhookClientBaseUrl(value: string | null): string | null {
  const url = parseHttpUrl(value);
  if (url === null) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseHttpUrl(value: string | null): URL | null {
  if (value === null || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export const parseOutgoingWebhookEndpoint = parseHttpUrl;

/** A header value must stay on one line and be printable, or it could split the request. */
export const isValidOutgoingWebhookHeaderValue = (value: string): boolean =>
  value.length > 0 &&
  value.length <= MAX_OUTGOING_WEBHOOK_SECRET_LENGTH &&
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point.
  !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value);
