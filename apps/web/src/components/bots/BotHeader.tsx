import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon } from "lucide-react";
import {
  resolveEnvironmentMachineKind,
  type ContextMenuItem,
  type EnvironmentId,
} from "@satslab/contracts";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEnvironments } from "../../state/environments";
import { botReset, useBots, useLastBotId, type useBotThreadContext } from "../../state/bots";
import { useClientSettings } from "../../hooks/useSettings";
import type { useThreadActionMenu } from "../../hooks/useThreadActionMenu";
import { useSidebarVisibility } from "../ui/sidebar";
import { T3Wordmark } from "../T3Wordmark";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { BotActionsProvider, useBotActions } from "./BotActions";

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
 * The header of a bot chat. Its title menu adds Rename and Transfer to the thread menu, like the
 * bot sidebar does. Subagent titles belong to a thread, not the bot, so they keep the plain menu.
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
  const { environments } = useEnvironments();
  const identity = useBots().find((item) => item.id === props.bot.botId);
  const allowed = useAtomValue(
    botReset.permissionAtom(identity?.ownerEnvironmentId ?? props.environmentId),
  );
  const environment = environments.find(
    (item) => item.environmentId === identity?.ownerEnvironmentId,
  );
  const disabled =
    !allowed || environment?.connection.phase !== "connected" || identity?.status !== "active";
  return (
    <BotHeader
      {...props}
      onOpenMenu={(position) => {
        if (!identity || props.bot.isSubagent) return openMenu(position);
        const items: ContextMenuItem[] = [
          { id: "rename", label: "Rename…", icon: "pencil", disabled },
          ...(actions.canMove(identity)
            ? [{ id: "move", label: "Transfer to another environment…", disabled }]
            : []),
        ];
        openMenu(position, {
          items,
          sharedItemsIndex: items.length,
          onSelect: (action) => {
            if (action === "rename" || action === "move") actions.open(identity, action);
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
        <span className="inline-flex shrink-0 items-center gap-2 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="Sora" className="size-5 shrink-0 rounded-md" />
          <span className="text-muted-foreground">Sora</span>
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
