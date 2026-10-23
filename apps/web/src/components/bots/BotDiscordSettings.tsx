import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  BotDiscordSettings as DiscordSettings,
  type BotDiscordStatus,
  type BotIdentity,
} from "@satslab/contracts";
import * as Schema from "effect/Schema";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  botDiscordConfigure,
  botDiscordSetCredential,
  botDiscordStatus,
} from "../../state/botDiscord";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { RefreshIcon } from "../ui/refresh-icon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const sameSettings = Schema.toEquivalence(DiscordSettings);

const connectionLabels = {
  disabled: "Disabled",
  connecting: "Connecting…",
  connected: "Connected",
  error: "Connection failed",
};

export function BotDiscordSettings({ bot, disabled }: { bot: BotIdentity; disabled: boolean }) {
  const query = useEnvironmentQuery(
    botDiscordStatus({
      environmentId: bot.ownerEnvironmentId,
      input: { botId: bot.id },
    }),
  );
  return (
    <SettingsSection title="Discord" id="bot-discord">
      {query.data ? (
        <DiscordSettingsForm
          key={`${bot.ownerEnvironmentId}:${bot.id}`}
          bot={bot}
          saved={query.data}
          disabled={disabled}
          refresh={query.refresh}
        />
      ) : (
        <SettingsRow
          title={query.error ?? "Loading Discord settings…"}
          control={
            query.error ? (
              <Button size="sm" variant="outline" onClick={query.refresh}>
                Retry
              </Button>
            ) : undefined
          }
        />
      )}
      {query.data && query.error ? (
        <SettingsRow
          title="Could not refresh Discord status"
          description={query.error}
          control={
            <Button size="sm" variant="outline" onClick={query.refresh}>
              Retry
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function DiscordSettingsForm({
  bot,
  saved,
  disabled,
  refresh,
}: {
  bot: BotIdentity;
  saved: BotDiscordStatus;
  disabled: boolean;
  refresh: () => void;
}) {
  const configure = useAtomCommand(botDiscordConfigure);
  const setCredential = useAtomCommand(botDiscordSetCredential);
  const canConfigure = useAtomValue(botDiscordConfigure.permissionAtom(bot.ownerEnvironmentId));
  const canSetCredential = useAtomValue(
    botDiscordSetCredential.permissionAtom(bot.ownerEnvironmentId),
  );
  const [draft, setDraft] = useState<Partial<DiscordSettings>>({});
  const [users, setUsers] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const values = { ...saved.settings, ...draft };
  const userText = users ?? values.userPolicy.userIds.join(", ");
  const userIds = [...new Set(userText.split(/[\s,]+/).filter(Boolean))];
  const invalidUsers = userIds.some((id) => !/^[0-9]{1,20}$/.test(id));
  const settings = { ...values, userPolicy: { ...values.userPolicy, userIds } };
  const changed = !sameSettings(settings, saved.settings);
  const unavailable = disabled || busy;
  // Disabling saves only `enabled`, so hidden or invalid drafts can't block it.
  const pendingDisable = !values.enabled && saved.settings.enabled;
  const connectionLabel =
    values.enabled && saved.connection === "disabled"
      ? saved.credentialConfigured
        ? "Not connected"
        : "Token required"
      : connectionLabels[saved.connection];

  const saveToken = async (value: string | null) => {
    if (unavailable || !canSetCredential) return;
    setBusy(true);
    const result = await setCredential({
      environmentId: bot.ownerEnvironmentId,
      input: { botId: bot.id, token: value },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setToken("");
      if (value === null) setDraft((current) => ({ ...current, enabled: false }));
      refresh();
    }
  };

  const saveSettings = async (next: DiscordSettings) => {
    if (unavailable || !canConfigure) return;
    setBusy(true);
    const result = await configure({
      environmentId: bot.ownerEnvironmentId,
      input: { botId: bot.id, settings: next },
    });
    setBusy(false);
    if (result._tag === "Success") refresh();
  };

  const discard = () => {
    setDraft({});
    setUsers(null);
  };

  return (
    <>
      <SettingsRow
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>Enable Discord</span>
            <span role="status" className="text-xs font-normal text-muted-foreground">
              {connectionLabel}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh Discord status"
              disabled={busy}
              onClick={refresh}
            >
              <RefreshIcon size="xs" />
            </Button>
          </span>
        }
        description={saved.error ?? undefined}
        control={
          <div className="flex items-center gap-2">
            {pendingDisable ? (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={discard}>
                  Discard
                </Button>
                <Button
                  size="sm"
                  disabled={unavailable || !canConfigure}
                  onClick={() => saveSettings({ ...saved.settings, enabled: false })}
                >
                  {busy ? "Saving…" : "Save"}
                </Button>
              </>
            ) : null}
            <Switch
              aria-label="Enable Discord"
              checked={values.enabled}
              disabled={unavailable || !canConfigure}
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
        }
      />
      {values.enabled ? (
        <>
          <SettingsRow
            title="Bot token"
            description={
              saved.credentialConfigured
                ? "Token saved. Enter a new token to replace it."
                : "Use the bot token from the Discord Developer Portal."
            }
            control={
              <form
                className="flex w-full flex-wrap items-center gap-2 sm:w-80"
                onSubmit={async (event) => {
                  event.preventDefault();
                  await saveToken(token.trim());
                }}
              >
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Discord bot token"
                    type="password"
                    autoComplete="new-password"
                    value={token}
                    disabled={unavailable || !canSetCredential}
                    onChange={(event) => setToken(event.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={unavailable || !canSetCredential || !token.trim()}
                >
                  Save token
                </Button>
                {saved.credentialConfigured ? (
                  <Button
                    size="sm"
                    variant="destructive-outline"
                    disabled={unavailable || !canSetCredential}
                    onClick={() => saveToken(null)}
                  >
                    Remove
                  </Button>
                ) : null}
              </form>
            }
          />
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!changed || invalidUsers || !saved.credentialConfigured) return;
              await saveSettings(settings);
            }}
          >
            {/* The fieldset wrapper hides these rows from SettingsGroup's direct-child rounding reset. */}
            <fieldset
              disabled={unavailable || !canConfigure}
              className="min-w-0 divide-y divide-border/50 [&>[data-slot=settings-row]]:rounded-none"
            >
              <SettingsRow
                title="Interaction mode"
                description="Replies to an accepted message or the bot count as follow-ups."
                control={
                  <Select
                    value={values.interactionMode}
                    onValueChange={(value) => {
                      if (value === "mention-only" || value === "all-messages")
                        setDraft({ ...draft, interactionMode: value });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Discord interaction mode">
                      <SelectValue>
                        {values.interactionMode === "mention-only"
                          ? "Mentions only"
                          : "All messages"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="mention-only">Mentions only</SelectItem>
                      <SelectItem value="all-messages">All messages</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                title="User policy"
                control={
                  <Select
                    value={values.userPolicy.mode}
                    onValueChange={(value) => {
                      if (value === "allow" || value === "block")
                        setDraft({ ...draft, userPolicy: { ...values.userPolicy, mode: value } });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Discord user policy">
                      <SelectValue>
                        {values.userPolicy.mode === "allow" ? "Allow list" : "Block list"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="allow">Allow list</SelectItem>
                      <SelectItem value="block">Block list</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                title={values.userPolicy.mode === "allow" ? "Allowed users" : "Blocked users"}
                description={
                  invalidUsers
                    ? "Enter Discord user IDs separated by commas or spaces."
                    : values.userPolicy.mode === "allow"
                      ? "An empty list allows everyone."
                      : "An empty list blocks nobody."
                }
                control={
                  <div className="w-full sm:w-80">
                    <Input
                      aria-label="Discord user IDs"
                      aria-invalid={invalidUsers}
                      value={userText}
                      onChange={(event) => setUsers(event.target.value)}
                      placeholder="123456789012345678, …"
                    />
                  </div>
                }
              />
              <SettingsRow
                title="Reply mode"
                control={
                  <Select
                    value={values.replyMode}
                    onValueChange={(value) => {
                      if (value === "thread" || value === "message")
                        setDraft({ ...draft, replyMode: value });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Discord reply mode">
                      <SelectValue>
                        {values.replyMode === "thread" ? "Reply in thread" : "Reply to message"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="thread">Reply in thread</SelectItem>
                      <SelectItem value="message">Reply to message</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
              <SettingsRow
                title=""
                control={
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={!changed} onClick={discard}>
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      type="submit"
                      disabled={!changed || invalidUsers || !saved.credentialConfigured}
                    >
                      {busy ? "Saving…" : "Save settings"}
                    </Button>
                  </div>
                }
              />
            </fieldset>
          </form>
        </>
      ) : null}
    </>
  );
}
