import { ArrowUpRightIcon, GitBranchIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useMemories } from "../../state/memories";
import { useEnvironments } from "../../state/environments";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { MemoryCompactionSettings } from "./MemoryCompactionSettings";
import { NewMemoryButton } from "./NewMemoryButton";
import { MemoryActionsProvider, MemoryActionsMenu, useMemoryActions } from "./MemoryActions";

export function MemoryManagementPanel() {
  return (
    <MemoryActionsProvider>
      <MemoryManagementRows />
    </MemoryActionsProvider>
  );
}

function MemoryManagementRows() {
  const memories = useMemories();
  const { environments } = useEnvironments();
  const { search } = useSettingsScope();
  const actions = useMemoryActions();
  const visible = memories.filter(
    (memory) => !search.machine || memory.ownerEnvironmentId === search.machine,
  );
  return (
    <SettingsPageContainer>
      <MemoryCompactionSettings />
      <SettingsSection title={`Memories (${visible.length})`} headerAction={<NewMemoryButton />}>
        {visible.length === 0 ? <SettingsRow title="No memories" /> : null}
        {visible.map((memory) => {
          const owner = environments.find((env) => env.environmentId === memory.ownerEnvironmentId);
          const connected = owner?.connection.phase === "connected";
          const paused = actions.paused(memory);
          return (
            <SettingsRow
              key={memory.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{memory.name}</span>
                </span>
              }
              description={
                <span className="flex flex-wrap items-center gap-1.5">
                  <EnvironmentMachineIcon
                    kind={resolveEnvironmentMachineKind(owner?.serverConfig ?? null)}
                    className="size-3.5"
                  />
                  {owner?.label ?? memory.ownerEnvironmentId}
                  {!connected ? " · Offline" : null}
                  {paused ? (actions.busy === memory.id ? " · Moving…" : " · Move paused") : null}
                </span>
              }
              control={
                <div className="flex items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Open ${memory.name}`}
                    title="Open memory"
                    disabled={!connected || memory.status !== "active"}
                    render={
                      <Link
                        to="/memory/$environmentId/$threadId"
                        params={{
                          environmentId: memory.ownerEnvironmentId,
                          threadId: memory.threadId,
                        }}
                      />
                    }
                  >
                    <ArrowUpRightIcon />
                  </Button>
                  <MemoryActionsMenu memory={memory} />
                </div>
              }
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
