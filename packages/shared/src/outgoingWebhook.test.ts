import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_OUTGOING_WEBHOOK_TEMPLATE } from "@satslab/contracts";

import {
  buildOutgoingWebhookNativeThreadUrls,
  buildOutgoingWebhookThreadUrl,
  isValidOutgoingWebhookHeaderValue,
  parseOutgoingWebhookTemplate,
  renderOutgoingWebhookTemplate,
  truncateOutgoingWebhookPreview,
  type OutgoingWebhookTemplateContext,
} from "./outgoingWebhook.ts";

const context: OutgoingWebhookTemplateContext = {
  thread: {
    id: "t-1",
    title: 'He said "hi"\nand left',
    url: "https://sora.test/e/t-1",
    soraUrl: "sora://threads/e/t-1",
    t3codeUrl: "t3code://threads/e/t-1",
  },
  message: { preview: "{{thread.id}} stays literal" },
  event: { type: "completed" },
};

const render = (template: string, values = context) => {
  const parsed = parseOutgoingWebhookTemplate(template);
  if (!parsed.ok) throw new Error(`template rejected: ${parsed.error.kind}`);
  return renderOutgoingWebhookTemplate(parsed, values);
};

describe("outgoing webhook templates", () => {
  it("substitutes inside string values and keeps the JSON valid despite quotes and newlines", () => {
    const body = JSON.parse(render(DEFAULT_OUTGOING_WEBHOOK_TEMPLATE));
    expect(body).toEqual({
      title: 'He said "hi"\nand left',
      body: "{{thread.id}} stays literal",
      url: "https://sora.test/e/t-1",
    });
  });

  it("renders embedded variables, nesting and non-string literals", () => {
    expect(
      JSON.parse(render('{"n":1,"ok":true,"x":null,"a":["{{event.type}}: {{ thread.id }}"]}')),
    ).toEqual({
      n: 1,
      ok: true,
      x: null,
      a: ["completed: t-1"],
    });
  });

  it.each([
    ["completed", "✅"],
    ["failed", "❌"],
    ["approval_required", "✋"],
    ["input_required", "💬"],
    ["test", "🧪"],
  ] as const)("renders the emoji for %s while retaining event.type", (type, emoji) => {
    const body = JSON.parse(
      render('{"title":"{{event.emoji}} {{thread.title}}","event":"{{event.type}}"}', {
        ...context,
        event: { type },
      }),
    );
    expect(body).toEqual({ title: `${emoji} ${context.thread.title}`, event: type });
  });

  it("does not treat plain text that equals a variable name as a variable", () => {
    expect(JSON.parse(render('{"label":"thread.id"}'))).toEqual({ label: "thread.id" });
  });

  it.each([
    ['{"a":{{thread.id}}}', "invalid_json"],
    ["not json", "invalid_json"],
    ['"{{thread.id}}"', "not_container"],
    ['{"a":"{{thread.secret}}"}', "unknown_variable"],
    ['{"{{thread.id}}":"x"}', "placeholder_in_key"],
    ['{"a":"oops {{ thread.id"}', "unmatched_braces"],
  ])("rejects %s", (template, kind) => {
    const parsed = parseOutgoingWebhookTemplate(template);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe(kind);
  });
});

describe("truncateOutgoingWebhookPreview", () => {
  it("returns short text trimmed", () => {
    expect(truncateOutgoingWebhookPreview("  hello \r\nworld  ", 50)).toBe("hello \nworld");
  });

  it("never splits a surrogate pair and stays within the limit", () => {
    const text = "ab😀😀😀";
    const cut = truncateOutgoingWebhookPreview(text, 4);
    expect(cut).toBe("ab😀…");
    expect(Array.from(cut).length).toBe(4);
    expect(JSON.stringify(cut)).not.toMatch(/\\ud[89ab]/i);
  });
});

describe("thread links", () => {
  it("builds the web route on the configured origin only", () => {
    expect(
      buildOutgoingWebhookThreadUrl({
        clientBaseUrl: "https://sora.example.com/app/",
        environmentId: "env 1",
        threadId: "thr/2",
      }),
    ).toBe("https://sora.example.com/app/env%201/thr%2F2");
  });

  it.each([null, "", "ftp://x", "not a url"])(
    "leaves the url empty for base %s",
    (clientBaseUrl) => {
      expect(
        buildOutgoingWebhookThreadUrl({ clientBaseUrl, environmentId: "e", threadId: "t" }),
      ).toBe("");
    },
  );
});

describe("native thread links", () => {
  it("builds both schemes on the app's thread route and renders them as variables", () => {
    expect(JSON.parse(render('{"s":"{{thread.soraUrl}}","t":"{{thread.t3codeUrl}}"}'))).toEqual({
      s: "sora://threads/e/t-1",
      t: "t3code://threads/e/t-1",
    });
  });

  it("encodes the environment and thread ids exactly once, including Unicode and reserved characters", () => {
    const urls = buildOutgoingWebhookNativeThreadUrls({
      environmentId: "env:ü 1",
      threadId: "スレッド/2?#%",
    });
    expect(urls.soraUrl).toBe(
      "sora://threads/env%3A%C3%BC%201/%E3%82%B9%E3%83%AC%E3%83%83%E3%83%89%2F2%3F%23%25",
    );
    expect(urls.t3codeUrl).toBe(urls.soraUrl.replace("sora://", "t3code://"));
    // One decode returns the ids, so nothing was encoded twice.
    const [, environment, thread] = new URL(urls.soraUrl).pathname.split("/");
    expect(decodeURIComponent(`${new URL(urls.soraUrl).host}`)).toBe("threads");
    expect(decodeURIComponent(environment ?? "")).toBe("env:ü 1");
    expect(decodeURIComponent(thread ?? "")).toBe("スレッド/2?#%");
  });
});

describe("isValidOutgoingWebhookHeaderValue", () => {
  it("rejects line breaks and control characters", () => {
    expect(isValidOutgoingWebhookHeaderValue("Bearer abc")).toBe(true);
    expect(isValidOutgoingWebhookHeaderValue("a\r\nX-Evil: 1")).toBe(false);
    expect(isValidOutgoingWebhookHeaderValue("a\u0000b")).toBe(false);
    expect(isValidOutgoingWebhookHeaderValue("")).toBe(false);
  });
});
