import { useEffect } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEnvironments } from "../../state/environments";
import { useBots, useLastBotId, type useBotThreadContext } from "../../state/bots";
import { useQuietThreadShell } from "../../state/entities";
import { useClientSettings } from "../../hooks/useSettings";
import type { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useThreadActions } from "../../hooks/useThreadActions";
import { toastManager } from "../ui/toast";
import { useSidebarVisibility } from "../ui/sidebar";
import { T3Wordmark } from "../T3Wordmark";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import {
  BotActionsProvider,
  runBotMenuAction,
  useBotActions,
  useBotMenuDisabled,
} from "./BotActions";
import { buildBotMenuItems } from "./BotMenu.logic";

type BotHeaderProps = {
  bot: NonNullable<ReturnType<typeof useBotThreadContext>>;
  environmentId: EnvironmentId;
  subagentTitle?: string | undefined;
  onOpenMenu?: ((position: { x: number; y: number }) => void) | undefined;
};

type BotChatHeaderProps = Omit<BotHeaderProps, "onOpenMenu"> & {
  openMenu: ReturnType<typeof useThreadActionMenu>["openMenu"];
};

/**
 * The header of a bot chat. Its title menu matches the bot sidebar item's. Subagent titles belong
 * to a thread, not the bot, so they keep the plain thread menu.
 */
export function BotChatHeader(props: BotChatHeaderProps) {
  return (
    <BotActionsProvider>
      <BotChatHeaderContent {...props} />
    </BotActionsProvider>
  );
}

function BotChatHeaderContent({ openMenu, ...props }: BotChatHeaderProps) {
  const actions = useBotActions();
  const identity = useBots().find((item) => item.id === props.bot.botId);
  const disabled = useBotMenuDisabled({
    ownerEnvironmentId: identity?.ownerEnvironmentId ?? props.environmentId,
    status: identity?.status ?? "deleted",
  });
  const { pinThread, unpinThread } = useThreadActions();
  const thread = useQuietThreadShell(
    identity ? { environmentId: identity.ownerEnvironmentId, threadId: identity.threadId } : null,
  );
  const pinned = thread?.pinnedAt != null;
  const togglePin = async (ref: ScopedThreadRef) => {
    const result = await (pinned ? unpinThread(ref) : pinThread(ref));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      toastManager.add({ type: "error", title: `Could not ${pinned ? "unpin" : "pin"} bot` });
  };
  return (
    <BotHeader
      {...props}
      onOpenMenu={(position) => {
        if (!identity || props.bot.isSubagent) return openMenu(position);
        const paused = actions.paused(identity);
        openMenu(position, {
          items: buildBotMenuItems({
            pinned,
            disabled,
            busy: actions.busy !== null,
            canMove: actions.canMove(identity),
            paused: paused
              ? paused.bot.status === "transferring"
                ? "transferring"
                : "forwarded"
              : null,
          }),
          sharedItemsIndex: 1,
          onSelect: (action) => {
            if (action === "pin")
              void togglePin({
                environmentId: identity.ownerEnvironmentId,
                threadId: identity.threadId,
              });
            else runBotMenuAction(actions, identity, action);
          },
        });
      }}
    />
  );
}

function BotHeader({ bot, environmentId, subagentTitle, onOpenMenu }: BotHeaderProps) {
  const bots = useBots();
  const router = useRouter();
  const alternateLayoutEnabled = useClientSettings((settings) => settings.alternateLayoutEnabled);
  const sidebarVisible = useSidebarVisibility();
  const botSidebarVisible =
    (alternateLayoutEnabled || router.options.basepath === "/layout") &&
    bots.length > 1 &&
    sidebarVisible;
  const [lastBotId, setLastBotId] = useLastBotId();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const current = bots.find((identity) => identity.id === bot.botId);
  const owner = current?.status === "active" ? current.ownerEnvironmentId : undefined;
  const currentThread = current?.threadId;
  const environment = environments.find((item) => item.environmentId === environmentId);
  const botName = current?.name ?? bot.title;
  useEffect(() => {
    if (lastBotId !== bot.botId) setLastBotId(bot.botId);
  }, [bot.botId, lastBotId, setLastBotId]);
  useEffect(() => {
    if (owner && currentThread && owner !== environmentId)
      void navigate({
        to: "/bots/$environmentId/$threadId",
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
      {!botSidebarVisible ? (
        <span className="inline-flex shrink-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto" />
          <span className="text-muted-foreground">Code</span>
        </span>
      ) : null}
      <WorkspaceBreadcrumb ariaLabel="Bot breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        {!bot.isSubagent ? (
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
        <WorkspaceBreadcrumbItem current={!bot.isSubagent} className="shrink">
          {bot.isSubagent ? (
            <Link
              to="/bots/$environmentId/$threadId"
              params={{ environmentId, threadId: bot.threadId }}
              className="min-w-0 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <WorkspaceBreadcrumbText>{botName}</WorkspaceBreadcrumbText>
            </Link>
          ) : (
            <button
              type="button"
              aria-label={`Thread actions for ${botName}`}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                onOpenMenu?.({ x: rect.left, y: rect.bottom + 4 });
              }}
              className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <WorkspaceBreadcrumbText>{botName}</WorkspaceBreadcrumbText>
              <ChevronDownIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
              />
            </button>
          )}
        </WorkspaceBreadcrumbItem>
        {bot.isSubagent ? (
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
