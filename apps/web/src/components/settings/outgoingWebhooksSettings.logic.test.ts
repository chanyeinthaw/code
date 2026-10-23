import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, OutgoingWebhookId, type OutgoingWebhook } from "@satslab/contracts";

import {
  draftFromWebhook,
  draftToUpsertInput,
  emptyWebhookDraft,
  insertTemplateVariable,
  previewTemplate,
  threadUrlWarning,
} from "./outgoingWebhooksSettings.logic";

const stored: OutgoingWebhook = {
  id: OutgoingWebhookId.make("owh_1"),
  name: "Hark",
  enabled: true,
  events: ["failed", "completed"],
  template: '{"body":"{{message.preview}}"}',
  previewLength: 300,
  clientBaseUrl: "https://sora.example.com",
  endpointOrigin: "https://hooks.example.com",
  endpointUrl: null,
  secretEndpoint: true,
  headerNames: ["Authorization"],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("webhook draft", () => {
  it("keeps stored secrets by omitting them on an edit", () => {
    const result = draftToUpsertInput(draftFromWebhook(stored, "edit"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.id).toBe(stored.id);
    expect(result.input.endpoint).toBeUndefined();
    expect(result.input.headers).toEqual([{ name: "Authorization" }]);
    expect(result.input.events).toEqual(["completed", "failed"]);
  });

  it("makes a copy a new webhook that needs its own endpoint and header values", () => {
    const draft = draftFromWebhook(stored, "copy");
    expect(draft.id).toBeNull();
    const missingEndpoint = draftToUpsertInput(draft);
    expect(missingEndpoint).toEqual({ ok: false, message: "Add the endpoint URL." });
    const missingHeader = draftToUpsertInput({
      ...draft,
      endpoint: "https://other.example.com/in",
    });
    expect(missingHeader).toEqual({ ok: false, message: "Header Authorization needs a value." });
    const ready = draftToUpsertInput({
      ...draft,
      endpoint: "https://other.example.com/in",
      headers: [{ key: "k", name: "Authorization", value: "Bearer x", stored: false }],
    });
    expect(ready.ok && ready.input.id).toBeFalsy();
    expect(ready.ok && ready.input.endpoint).toEqual({ value: "https://other.example.com/in" });
  });

  it("copies an ordinary URL but still requires new header credentials", () => {
    const draft = draftFromWebhook(
      {
        ...stored,
        endpointUrl: "https://hooks.example.com/in",
        secretEndpoint: false,
      },
      "copy",
    );
    expect(draft.endpoint).toBe("https://hooks.example.com/in");
    expect(draft.secretEndpoint).toBe(false);
    expect(draftToUpsertInput(draft)).toEqual({
      ok: false,
      message: "Header Authorization needs a value.",
    });
    const ready = draftToUpsertInput({ ...draft, headers: [] });
    expect(ready.ok && ready.input.endpoint).toEqual({ value: draft.endpoint });
  });

  it("sends an explicit visibility change while retaining a stored secret URL", () => {
    const draft = draftFromWebhook(stored, "edit");
    const result = draftToUpsertInput({ ...draft, secretEndpoint: false });
    expect(result.ok && result.input.endpoint).toBeUndefined();
    expect(result.ok && result.input.secretEndpoint).toBe(false);
    expect(emptyWebhookDraft().secretEndpoint).toBe(false);
  });

  it("refuses an unusable draft with a reason", () => {
    const base = { ...emptyWebhookDraft(), name: "x", endpoint: "https://a.example.com" };
    expect(draftToUpsertInput({ ...base, name: " " })).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...base, events: [] })).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...base, template: '{"a":"{{nope}}"}' })).toMatchObject({
      ok: false,
    });
    expect(draftToUpsertInput({ ...base, previewLength: "0" })).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...base, endpoint: "ftp://a" })).toMatchObject({ ok: false });
    expect(draftToUpsertInput({ ...base, clientBaseUrl: "nope" })).toMatchObject({ ok: false });
    expect(draftToUpsertInput(base).ok).toBe(true);
  });
});

describe("template editing", () => {
  it("inserts a variable over the selection", () => {
    expect(insertTemplateVariable('{"a":"X"}', { start: 6, end: 7 }, "thread.id")).toEqual({
      template: '{"a":"{{thread.id}}"}',
      cursor: 19,
    });
  });

  it("inserts and previews event.emoji for the completed preview", () => {
    const inserted = insertTemplateVariable('{"title":""}', { start: 10, end: 10 }, "event.emoji");
    expect(inserted.template).toBe('{"title":"{{event.emoji}}"}');
    const preview = previewTemplate(
      {
        template: '{"title":"{{event.emoji}} {{thread.title}}","event":"{{event.type}}"}',
        previewLength: "500",
        clientBaseUrl: "",
      },
      null,
    );
    expect(preview.ok && JSON.parse(preview.body)).toEqual({
      title: "✅ Fix the login redirect",
      event: "completed",
    });
  });

  it("previews with the draft's link settings and preview length", () => {
    const withBase = previewTemplate(
      {
        template: '{"u":"{{thread.url}}","p":"{{message.preview}}"}',
        previewLength: "10",
        clientBaseUrl: "https://sora.example.com",
      },
      null,
    );
    expect(withBase.ok && JSON.parse(withBase.body)).toEqual({
      u: "https://sora.example.com/environment/thread-sample",
      p: "Done. The…",
    });
    const without = previewTemplate(
      { template: '{"u":"{{thread.url}}"}', previewLength: "10", clientBaseUrl: "" },
      null,
    );
    expect(without.ok && JSON.parse(without.body)).toEqual({ u: "" });
  });

  it("previews native links without a client URL using the selected environment", () => {
    const preview = previewTemplate(
      {
        template:
          '{"web":"{{thread.url}}","sora":"{{thread.soraUrl}}","t3":"{{thread.t3codeUrl}}"}',
        previewLength: "500",
        clientBaseUrl: "",
      },
      EnvironmentId.make("env:ü/?"),
    );
    expect(preview.ok && JSON.parse(preview.body)).toEqual({
      web: "",
      sora: "sora://threads/env%3A%C3%BC%2F%3F/thread-sample",
      t3: "t3code://threads/env%3A%C3%BC%2F%3F/thread-sample",
    });
  });

  it("warns only when thread.url is used without a client URL", () => {
    expect(threadUrlWarning({ template: '{"u":"{{thread.url}}"}', clientBaseUrl: "" })).toContain(
      "client URL",
    );
    expect(
      threadUrlWarning({
        template: '{"u":"{{thread.url}}"}',
        clientBaseUrl: "https://a.example.com",
      }),
    ).toBeNull();
    expect(threadUrlWarning({ template: '{"u":"{{thread.id}}"}', clientBaseUrl: "" })).toBeNull();
  });
});
