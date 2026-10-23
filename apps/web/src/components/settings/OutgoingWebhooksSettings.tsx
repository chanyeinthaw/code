import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  OUTGOING_WEBHOOK_EVENT_TYPES,
  OUTGOING_WEBHOOK_TEMPLATE_VARIABLES,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type OutgoingWebhook,
} from "@satslab/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@satslab/client-runtime/state/runtime";
import {
  CopyIcon,
  InboxIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  Trash2Icon,
  WebhookIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironment, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  deliveryLabel,
  deliveryVariant,
  draftFromWebhook,
  draftToUpsertInput,
  emptyWebhookDraft,
  EVENT_LABELS,
  insertTemplateVariable,
  previewTemplate,
  threadUrlWarning,
  type OutgoingWebhookDraft,
} from "./outgoingWebhooksSettings.logic";

type EditorTarget = {
  readonly environmentId: EnvironmentId;
  readonly draft: OutgoingWebhookDraft;
  /** The environment a copy came from, so it can be told apart in the dialog. */
  readonly copiedFrom: EnvironmentId | null;
};

const reportFailure = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

function Field({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export function OutgoingWebhooksSettings() {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const defaultEnvironment = environment ?? connectedEnvironments[0];
  const canCreate = useAtomValue(
    serverEnvironment.upsertOutgoingWebhook.permissionAtom(
      defaultEnvironment?.environmentId ?? null,
    ),
  );
  return (
    <SettingsSection
      id="outgoing-webhooks"
      title="Outgoing webhooks"
      variant="plain"
      headerAction={
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={!defaultEnvironment || !canCreate}
          onClick={() =>
            defaultEnvironment &&
            setEditor({
              environmentId: defaultEnvironment.environmentId,
              draft: emptyWebhookDraft(),
              copiedFrom: null,
            })
          }
        >
          <PlusIcon className="size-3" />
          New webhook
        </Button>
      }
    >
      {scope.kind === "unavailable" ? (
        <SettingsRow title={scope.message} />
      ) : environments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WebhookIcon />
            </EmptyMedia>
            <EmptyTitle>No environments available</EmptyTitle>
            <EmptyDescription>Connect an environment to manage webhooks.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-8">
          {environments.map((entry) => (
            <WebhookEnvironmentSection
              key={entry.environmentId}
              environment={entry}
              showEnvironmentHeading={environments.length > 1}
              onEdit={setEditor}
            />
          ))}
        </div>
      )}
      {editor ? (
        <WebhookEditorDialog
          key={`${editor.environmentId}:${editor.draft.id ?? "new"}`}
          target={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function WebhookEnvironmentSection({
  environment,
  showEnvironmentHeading,
  onEdit,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
  readonly onEdit: (target: EditorTarget) => void;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const query = useEnvironmentQuery(
    connected
      ? serverEnvironment.outgoingWebhooksLive({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const webhooks = query.data?.webhooks;
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected ? (
        <SettingsRow
          title="Environment disconnected"
          description={`Reconnect ${environment.label} to view its webhooks.`}
        />
      ) : query.error ? (
        <SettingsRow title="Could not load webhooks" description={query.error} />
      ) : !webhooks ? (
        <SettingsRow title="Loading webhooks…" role="status" />
      ) : webhooks.length === 0 ? (
        <SettingsRow title="No webhooks" />
      ) : (
        webhooks.map((webhook) => (
          <WebhookRow
            key={webhook.id}
            environmentId={environment.environmentId}
            webhook={webhook}
            onEdit={onEdit}
          />
        ))
      )}
    </SettingsSection>
  );
}

function WebhookRow({
  environmentId,
  webhook,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly webhook: OutgoingWebhook;
  readonly onEdit: (target: EditorTarget) => void;
}) {
  const { connectedEnvironments } = useSettingsScope();
  const canOperate = useAtomValue(
    serverEnvironment.upsertOutgoingWebhook.permissionAtom(environmentId),
  );
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const upsert = useAtomCommand(serverEnvironment.upsertOutgoingWebhook, {
    label: "outgoing webhook enabled",
  });
  const remove = useAtomCommand(serverEnvironment.deleteOutgoingWebhook, {
    label: "outgoing webhook delete",
  });
  const test = useAtomCommand(serverEnvironment.testOutgoingWebhook, {
    label: "outgoing webhook test",
  });
  const copyTarget = connectedEnvironments.find((entry) => entry.environmentId !== environmentId);

  const settle = (title: string, result: { readonly _tag: string }) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result as never)) {
      reportFailure(title, String(squashAtomCommandFailure(result as never)));
    }
  };
  const toggle = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const draft = draftFromWebhook(webhook, "edit");
    const input = draftToUpsertInput({ ...draft, enabled: !webhook.enabled });
    if (!input.ok) return reportFailure("Could not update webhook", input.message);
    setBusy(true);
    settle("Could not update webhook", await upsert({ environmentId, input: input.input }));
    setBusy(false);
  };
  const sendTest = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    setBusy(true);
    const result = await test({ environmentId, input: { id: webhook.id } });
    setBusy(false);
    if (result._tag === "Success") {
      const ok = result.value.delivery.status === "succeeded";
      toastManager.add(
        stackedThreadToast({
          type: ok ? "success" : "error",
          title: ok ? "Test sent" : "Test failed",
          description: deliveryLabel(result.value.delivery),
        }),
      );
    } else settle("Could not send test", result);
  };
  const confirmDelete = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const confirmed =
      (await requestConfirmDialog(
        `Delete “${webhook.name}”?\nIts endpoint, headers, queued deliveries and history are removed.`,
        { variant: "destructive" },
      )) ?? window.confirm(`Delete “${webhook.name}”?`);
    if (!confirmed) return;
    setBusy(true);
    settle("Could not delete webhook", await remove({ environmentId, input: { id: webhook.id } }));
    setBusy(false);
  };

  return (
    <SettingsRow
      title={webhook.name}
      description={
        <span className="block truncate">{webhook.endpointUrl ?? webhook.endpointOrigin}</span>
      }
      status={
        <span>
          {webhook.enabled ? "Active" : "Paused"} ·{" "}
          {webhook.events.map((type) => EVENT_LABELS[type]).join(", ")}
        </span>
      }
      control={
        <div className="flex items-center gap-2">
          <Switch
            checked={webhook.enabled}
            disabled={busy || !canOperate}
            aria-label={`Enable ${webhook.name}`}
            onCheckedChange={() => void toggle()}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${webhook.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={!canOperate}
                onClick={() =>
                  onEdit({
                    environmentId,
                    draft: draftFromWebhook(webhook, "edit"),
                    copiedFrom: null,
                  })
                }
              >
                <PencilIcon />
                Edit
              </MenuItem>
              <MenuItem disabled={!canOperate} onClick={() => void sendTest()}>
                <SendIcon />
                Send test
              </MenuItem>
              <MenuItem onClick={() => setDeliveriesOpen(true)}>
                <InboxIcon />
                Deliveries
              </MenuItem>
              {copyTarget ? (
                <MenuItem
                  onClick={() =>
                    onEdit({
                      environmentId: copyTarget.environmentId,
                      draft: draftFromWebhook(webhook, "copy"),
                      copiedFrom: environmentId,
                    })
                  }
                >
                  <CopyIcon />
                  Copy to another environment
                </MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem disabled={!canOperate} onClick={() => void confirmDelete()}>
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuPopup>
          </Menu>
          {deliveriesOpen ? (
            <DeliveriesDialog
              environmentId={environmentId}
              webhook={webhook}
              onClose={() => setDeliveriesOpen(false)}
            />
          ) : null}
        </div>
      }
    />
  );
}

function DeliveriesDialog({
  environmentId,
  webhook,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly webhook: OutgoingWebhook;
  readonly onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.outgoingWebhookDeliveries({
      environmentId,
      input: { webhookId: webhook.id },
    }),
  );
  const deliveries = query.data?.deliveries ?? null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {webhook.name}</DialogTitle>
          <DialogDescription>
            Delivery is at least once; retries reuse one Idempotency-Key.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.error ? <p className="text-sm text-destructive">{query.error}</p> : null}
          {deliveries === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading deliveries…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <Badge variant={deliveryVariant(delivery.status)}>
                    {deliveryLabel(delivery)}
                  </Badge>
                  <span>
                    {delivery.eventType === "test" ? "Test" : EVENT_LABELS[delivery.eventType]}
                  </span>
                  <span className="text-muted-foreground">
                    {formatRelativeTimeLabel(delivery.updatedAt)}
                  </span>
                  {delivery.attempts > 1 ? (
                    <span className="text-muted-foreground">{delivery.attempts} attempts</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={query.isPending} onClick={query.refresh}>
            Refresh
          </Button>
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WebhookEditorDialog({
  target,
  onClose,
}: {
  readonly target: EditorTarget;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <WebhookEditorForm
          target={target}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

function WebhookEditorForm({
  target,
  saving,
  onSavingChange: setSaving,
  onClose,
}: {
  readonly target: EditorTarget;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const { connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(target.environmentId);
  const environment = useEnvironment(environmentId);
  const [draft, setDraft] = useState(target.draft);
  const upsert = useAtomCommand(serverEnvironment.upsertOutgoingWebhook, {
    label: "outgoing webhook upsert",
  });
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const nextHeaderKey = useRef(0);
  const editing = draft.id !== null;
  const copying = target.copiedFrom !== null;
  const preview = previewTemplate(draft, environmentId);
  const linkWarning = threadUrlWarning(draft);
  const patch = (changes: Partial<OutgoingWebhookDraft>) =>
    setDraft((current) => ({ ...current, ...changes }));

  // Puts the cursor after an inserted variable once the new text has rendered.
  useEffect(() => {
    const cursor = pendingCursor.current;
    if (cursor === null) return;
    pendingCursor.current = null;
    templateRef.current?.focus();
    templateRef.current?.setSelectionRange(cursor, cursor);
  });

  const insertVariable = (variable: (typeof OUTGOING_WEBHOOK_TEMPLATE_VARIABLES)[number]) => {
    const area = templateRef.current;
    const next = insertTemplateVariable(
      draft.template,
      {
        start: area?.selectionStart ?? draft.template.length,
        end: area?.selectionEnd ?? draft.template.length,
      },
      variable,
    );
    patch({ template: next.template });
    pendingCursor.current = next.cursor;
  };

  const submit = async () => {
    if (saving || !readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    const result = draftToUpsertInput(draft);
    if (!result.ok) return reportFailure("Webhook is incomplete", result.message);
    setSaving(true);
    const saved = await upsert({ environmentId, input: result.input });
    setSaving(false);
    if (saved._tag === "Failure") {
      if (!isAtomCommandInterrupted(saved)) {
        reportFailure("Could not save webhook", String(squashAtomCommandFailure(saved)));
      }
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {editing ? "Edit webhook" : copying ? "Copy webhook" : "New webhook"}
        </DialogTitle>
        {copying ? (
          <DialogDescription>
            Enter this environment's own header values, and the endpoint if it is secret. Secrets
            are not copied.
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          <Field label="Environment" htmlFor="outgoing-webhook-environment">
            <Select
              value={environmentId}
              disabled={editing || saving}
              onValueChange={(id) => {
                const next = connectedEnvironments.find((entry) => entry.environmentId === id);
                if (next) setEnvironmentId(next.environmentId);
              }}
            >
              <SelectTrigger id="outgoing-webhook-environment" size="sm">
                <SelectValue>{environment?.label ?? "Unavailable environment"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectedEnvironments
                  .filter((entry) => entry.environmentId !== target.copiedFrom)
                  .map((entry) => (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      {entry.label}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field label="Name" htmlFor="outgoing-webhook-name">
            <Input
              id="outgoing-webhook-name"
              placeholder="e.g. Hark"
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </Field>
          <Field label="Endpoint URL" htmlFor="outgoing-webhook-endpoint">
            <Input
              id="outgoing-webhook-endpoint"
              type={draft.secretEndpoint ? "password" : "text"}
              autoComplete="off"
              placeholder={
                editing && draft.secretEndpoint
                  ? "Stored. Enter a new URL to replace it."
                  : "https://"
              }
              value={draft.endpoint}
              onChange={(event) => patch({ endpoint: event.target.value })}
            />
            <label className="mt-2 flex items-center justify-between gap-3 text-sm">
              <span>
                Secret URL
                <span className="block text-xs text-muted-foreground">
                  Hide the URL after saving. Turn on if it contains a key or token.
                </span>
              </span>
              <Switch
                checked={draft.secretEndpoint}
                onCheckedChange={(secretEndpoint) => patch({ secretEndpoint })}
              />
            </label>
          </Field>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Headers</Label>
              <Button
                size="xs"
                variant="ghost-muted"
                onClick={() =>
                  patch({
                    headers: [
                      ...draft.headers,
                      { key: `new:${nextHeaderKey.current++}`, name: "", value: "", stored: false },
                    ],
                  })
                }
              >
                <PlusIcon className="size-3" />
                Add header
              </Button>
            </div>
            {draft.headers.map((header, index) => (
              <div key={header.key} className="flex items-center gap-2">
                <Input
                  aria-label="Header name"
                  className="max-w-40"
                  placeholder="Authorization"
                  disabled={header.stored}
                  value={header.name}
                  onChange={(event) =>
                    patch({
                      headers: draft.headers.map((entry, at) =>
                        at === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Input
                  aria-label={`${header.name || "Header"} value`}
                  type="password"
                  autoComplete="off"
                  placeholder={header.stored ? "Stored" : "Value"}
                  value={header.value}
                  onChange={(event) =>
                    patch({
                      headers: draft.headers.map((entry, at) =>
                        at === index ? { ...entry, value: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${header.name || "header"}`}
                  onClick={() => patch({ headers: draft.headers.filter((_, at) => at !== index) })}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <Label>Send when</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {OUTGOING_WEBHOOK_EVENT_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.events.includes(type)}
                    onCheckedChange={(checked) =>
                      patch({
                        events: checked
                          ? [...draft.events, type]
                          : draft.events.filter((entry) => entry !== type),
                      })
                    }
                  />
                  {EVENT_LABELS[type]}
                </label>
              ))}
            </div>
          </div>
          <Field label="Body template" htmlFor="outgoing-webhook-template">
            <Textarea
              id="outgoing-webhook-template"
              ref={templateRef}
              rows={5}
              spellCheck={false}
              value={draft.template}
              onChange={(event) => patch({ template: event.target.value })}
            />
            <div className="flex flex-wrap gap-1.5">
              {OUTGOING_WEBHOOK_TEMPLATE_VARIABLES.map((variable) => (
                <Button
                  key={variable}
                  size="xs"
                  variant="outline"
                  onClick={() => insertVariable(variable)}
                >
                  {variable}
                </Button>
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Preview length" htmlFor="outgoing-webhook-preview-length">
              <Input
                id="outgoing-webhook-preview-length"
                inputMode="numeric"
                value={draft.previewLength}
                onChange={(event) => patch({ previewLength: event.target.value })}
              />
            </Field>
            <Field label="Client URL" htmlFor="outgoing-webhook-client-url">
              <Input
                id="outgoing-webhook-client-url"
                placeholder="https://"
                value={draft.clientBaseUrl}
                onChange={(event) => patch({ clientBaseUrl: event.target.value })}
              />
            </Field>
          </div>
          {linkWarning ? <p className="text-xs text-warning-foreground">{linkWarning}</p> : null}
          <div className="space-y-1.5">
            <Label>Preview</Label>
            <pre
              className={
                preview.ok
                  ? "max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all"
                  : "rounded-md bg-muted p-2 text-xs text-destructive"
              }
            >
              {preview.ok ? preview.body : preview.message}
            </pre>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            Enabled
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => patch({ enabled })} />
          </label>
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button size="sm" disabled={saving} onClick={() => void submit()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
