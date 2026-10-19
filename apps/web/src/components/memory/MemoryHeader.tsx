import { useEffect } from "react";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEnvironments } from "../../state/environments";
import { useMemories, useLastMemoryId, type useMemoryThreadContext } from "../../state/memories";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarVisibility } from "../ui/sidebar";
import { T3Wordmark } from "../T3Wordmark";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

export function MemoryHeader({
  memory,
  environmentId,
  subagentTitle,
}: {
  memory: NonNullable<ReturnType<typeof useMemoryThreadContext>>;
  environmentId: EnvironmentId;
  subagentTitle?: string | undefined;
}) {
  const memories = useMemories();
  const router = useRouter();
  const alternateLayoutEnabled = useClientSettings((settings) => settings.alternateLayoutEnabled);
  const sidebarVisible = useSidebarVisibility();
  const memorySidebarVisible =
    (alternateLayoutEnabled || router.options.basepath === "/layout") &&
    memories.length > 1 &&
    sidebarVisible;
  const [lastMemoryId, setLastMemoryId] = useLastMemoryId();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const current = memories.find((identity) => identity.id === memory.memoryId);
  const owner = current?.status === "active" ? current.ownerEnvironmentId : undefined;
  const currentThread = current?.threadId;
  const environment = environments.find((item) => item.environmentId === environmentId);
  const memoryName = current?.name ?? memory.title;
  useEffect(() => {
    if (lastMemoryId !== memory.memoryId) setLastMemoryId(memory.memoryId);
  }, [memory.memoryId, lastMemoryId, setLastMemoryId]);
  useEffect(() => {
    if (owner && currentThread && owner !== environmentId)
      void navigate({
        to: "/memory/$environmentId/$threadId",
        params: { environmentId: owner, threadId: currentThread },
        replace: true,
      });
  }, [owner, currentThread, environmentId, navigate]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      {!memorySidebarVisible ? (
        <span className="inline-flex shrink-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto" />
          <span className="text-muted-foreground">Code</span>
        </span>
      ) : null}
      <WorkspaceBreadcrumb ariaLabel="Memory breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        {!memory.isSubagent ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <EnvironmentMachineIcon
                kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
                className="mr-1.5 size-3.5 shrink-0"
              />
              <WorkspaceBreadcrumbText>
                {environment?.label ?? environmentId}
              </WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current={!memory.isSubagent} className="shrink">
          {memory.isSubagent ? (
            <Link
              to="/memory/$environmentId/$threadId"
              params={{ environmentId, threadId: memory.threadId }}
              className="min-w-0 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <WorkspaceBreadcrumbText>{memoryName}</WorkspaceBreadcrumbText>
            </Link>
          ) : (
            <WorkspaceBreadcrumbText>{memoryName}</WorkspaceBreadcrumbText>
          )}
        </WorkspaceBreadcrumbItem>
        {memory.isSubagent ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="shrink">
              <WorkspaceBreadcrumbText>{subagentTitle ?? "Subagent"}</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
    </div>
  );
}
