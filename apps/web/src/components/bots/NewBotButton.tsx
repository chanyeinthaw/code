import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SquarePenIcon } from "lucide-react";
import type { EnvironmentId } from "@satslab/contracts";
import { botChatProviderDisabledReason } from "@satslab/shared/botChat";
import {
  useEnvironments,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { useCreateBot } from "./useCreateBot";
import { BotEnvironmentSelect } from "./BotEnvironmentSelect";
import { BotActionButton } from "./BotActionButton";
import { Button } from "../ui/button";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function NewBotButton({ sidebar = false }: { sidebar?: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  const createFormId = useId();
  const [createEnvironmentId, setCreateEnvironmentId] = useState<EnvironmentId | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settingsScope = useOptionalSettingsScope();
  const navigate = useNavigate();
  const createBot = useCreateBot();
  const connectedEnvironments = environments.filter(
    (item) => item.connection.phase === "connected",
  );
  const creationEnvironment =
    connectedEnvironments.find((item) => item.environmentId === createEnvironmentId) ??
    connectedEnvironments.find((item) => item.environmentId === settingsScope?.search.machine) ??
    connectedEnvironments.find((item) => item.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0];
  const create = async (environmentId: EnvironmentId) => {
    if (creating) return;
    setCreating(true);
    const bot = await createBot(environmentId, name.trim()).finally(() => setCreating(false));
    if (bot._tag === "Success") {
      setCreateOpen(false);
      await navigate({
        to: "/bots/$environmentId/$threadId",
        params: { environmentId: bot.value.ownerEnvironmentId, threadId: bot.value.threadId },
      });
    }
  };
  return (
    <>
      {sidebar ? (
        <SidebarHeaderIconButton
          label="New bot"
          disabled={connectedEnvironments.length === 0}
          onClick={() => {
            setName("");
            setCreateOpen(true);
          }}
        >
          <SquarePenIcon />
        </SidebarHeaderIconButton>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={connectedEnvironments.length === 0}
          onClick={() => {
            setName("");
            setCreateOpen(true);
          }}
        >
          <PlusIcon />
          New bot
        </Button>
      )}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
      >
        <DialogPopup showCloseButton={!creating}>
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <form
              id={createFormId}
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (creationEnvironment) void create(creationEnvironment.environmentId);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="bot-name">Name</Label>
                <Input
                  id="bot-name"
                  maxLength={255}
                  placeholder="Random star name"
                  value={name}
                  disabled={creating}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {connectedEnvironments.length > 1 ? (
                <BotEnvironmentSelect
                  label="Environment"
                  environments={connectedEnvironments}
                  value={creationEnvironment?.environmentId ?? null}
                  disabled={creating}
                  onChange={setCreateEnvironmentId}
                />
              ) : null}
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={creating} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            {creationEnvironment ? (
              <BotActionButton
                type="submit"
                form={createFormId}
                environmentId={creationEnvironment.environmentId}
                disabled={
                  creating ||
                  !(providers.get(creationEnvironment.environmentId) ?? []).some(
                    (provider) => botChatProviderDisabledReason(provider) === null,
                  )
                }
              >
                {creating ? "Creating…" : "Create bot"}
              </BotActionButton>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
