import { useId, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, SquarePenIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { memoryChatProviderDisabledReason } from "@t3tools/shared/memoryChat";
import {
  useEnvironments,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { useCreateMemory } from "./useCreateMemory";
import { MemoryEnvironmentSelect } from "./MemoryEnvironmentSelect";
import { MemoryActionButton } from "./MemoryActionButton";
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

export function NewMemoryButton({ sidebar = false }: { sidebar?: boolean }) {
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
  const createMemory = useCreateMemory();
  const connectedEnvironments = environments.filter(
    (item) => item.connection.phase === "connected",
  );
  const creationEnvironment =
    connectedEnvironments.find((item) => item.environmentId === createEnvironmentId) ??
    connectedEnvironments.find((item) => item.environmentId === settingsScope?.search.machine) ??
    connectedEnvironments.find((item) => item.environmentId === primaryEnvironmentId) ??
    connectedEnvironments[0];
  const create = async (environmentId: EnvironmentId) => {
    if (creating || !name.trim()) return;
    setCreating(true);
    const memory = await createMemory(environmentId, name.trim()).finally(() => setCreating(false));
    if (memory._tag === "Success") {
      setCreateOpen(false);
      await navigate({
        to: "/memory/$environmentId/$threadId",
        params: { environmentId: memory.value.ownerEnvironmentId, threadId: memory.value.threadId },
      });
    }
  };
  return (
    <>
      {sidebar ? (
        <SidebarHeaderIconButton
          label="New memory"
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
          New memory
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
            <DialogTitle>New memory</DialogTitle>
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
                <Label htmlFor="memory-name">Name</Label>
                <Input
                  id="memory-name"
                  maxLength={255}
                  placeholder="Memory name"
                  value={name}
                  disabled={creating}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {connectedEnvironments.length > 1 ? (
                <MemoryEnvironmentSelect
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
              <MemoryActionButton
                type="submit"
                form={createFormId}
                environmentId={creationEnvironment.environmentId}
                disabled={
                  creating ||
                  !name.trim() ||
                  !(providers.get(creationEnvironment.environmentId) ?? []).some(
                    (provider) => memoryChatProviderDisabledReason(provider) === null,
                  )
                }
              >
                {creating ? "Creating…" : "Create memory"}
              </MemoryActionButton>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
