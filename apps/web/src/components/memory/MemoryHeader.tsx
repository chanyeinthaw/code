import { useEffect } from "react";
import { ChevronDownIcon } from "lucide-react";
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
  onOpenMenu,
}: {
  memory: NonNullable<ReturnType<typeof useMemoryThreadContext>>;
  environmentId: EnvironmentId;
  subagentTitle?: string | undefined;
  onOpenMenu?: ((position: { x: number; y: number }) => void) | undefined;
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
    <div
      className="flex min-w-0 flex-1 items-center gap-3"
      onContextMenu={
        onOpenMenu
          ? (event) => {
              event.preventDefault();
              onOpenMenu({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
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
            <button
              type="button"
              aria-label={`Thread actions for ${memoryName}`}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMenu?.({ x: rect.left, y: rect.bottom + 4 });
              }}
              className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <WorkspaceBreadcrumbText>{memoryName}</WorkspaceBreadcrumbText>
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
              />
            </button>
          )}
        </WorkspaceBreadcrumbItem>
        {memory.isSubagent ? (
          <>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="shrink">
              <button
                type="button"
                aria-label={`Thread actions for ${subagentTitle ?? "Subagent"}`}
                aria-haspopup="menu"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenMenu?.({ x: rect.left, y: rect.bottom + 4 });
                }}
                className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <WorkspaceBreadcrumbText>{subagentTitle ?? "Subagent"}</WorkspaceBreadcrumbText>
                <ChevronDownIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </button>
            </WorkspaceBreadcrumbItem>
          </>
        ) : null}
      </WorkspaceBreadcrumb>
    </div>
  );
}
