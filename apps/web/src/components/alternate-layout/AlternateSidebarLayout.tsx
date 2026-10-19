import { useLastActiveBot, useBots, useBotThreadShells } from "../../state/bots";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, MessagesSquareIcon, BotIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects, useThreadShells } from "../../state/entities";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  resolveNavigationSection,
  resolveNavigationStatus,
  type NavigationSection,
} from "./navigation.logic";
import { resolveThreadsNavigationHref } from "./threadNavigation";
import { isElectron } from "../../env";
import { useWindowFullscreen } from "../../hooks/useWindowFullscreen";
import { isMacPlatform } from "../../lib/utils";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { usePullRequestsSupported } from "../../state/environments";
import { AlternateSidebarFrame } from "./AlternateSidebarFrame";
import { AlternateSidebarHeader } from "./AlternateSidebarHeader";
import { SidebarProviderUpdatePill } from "../sidebar/SidebarProviderUpdatePill";
import Sidebar from "../Sidebar";
import type { SidebarRouteReveal } from "../sidebar/routeReveal";
import { BotSidebar } from "../bots/BotSidebar";
import { Button } from "../ui/button";
import { SidebarFooter, SidebarMenu, SidebarTrigger, useSidebarVisibility } from "../ui/sidebar";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const lastThreadHrefSchema = Schema.NullOr(Schema.String);
const navigationSectionSchema = Schema.Literals(["bots", "threads"]);

export function AlternateSidebarLayout({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [rememberedSection, setRememberedSection] = useLocalStorage(
    "alternate-navigation-section",
    "threads",
    navigationSectionSchema,
  );
  const section = resolveNavigationSection(pathname, rememberedSection);
  useEffect(() => {
    if (section !== rememberedSection) setRememberedSection(section);
  }, [section, rememberedSection, setRememberedSection]);
  const [routeReveal] = useState<SidebarRouteReveal>(() => ({
    observedKey: null,
    pendingKey: null,
  }));
  return (
    <AlternateSidebarFrame
      section={section}
      navigationRail={<AlternateNavigationRail section={section} />}
      botSidebar={<BotSidebar />}
      threadSidebar={
        <>
          <AlternateSidebarHeader />
          <Sidebar presentation="alternate" routeReveal={routeReveal} />
          <AlternateSidebarFooter />
        </>
      }
    >
      {children}
    </AlternateSidebarFrame>
  );
}

function NavigationButton({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon"
            aria-label={label}
            data-pressed={props["aria-current"] === "page" || undefined}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function NavigationStatusIcon({
  children,
  status,
}: {
  children: ReactNode;
  status: ReturnType<typeof resolveNavigationStatus>;
}) {
  return (
    <span className="relative inline-flex">
      {children}
      {status ? (
        <>
          <span
            aria-hidden="true"
            className={`absolute -right-1 -top-1 size-1.5 rounded-full ring-2 ring-background ${status.dotClass}`}
          />
          <span className="sr-only">{status.label}</span>
        </>
      ) : null}
    </span>
  );
}

function AlternateSidebarFooter() {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
    </SidebarFooter>
  );
}

function AlternateNavigationRail({ section }: { section: NavigationSection }) {
  const sidebarVisible = useSidebarVisibility();
  const fullscreen = useWindowFullscreen();
  const reserveTrafficLights = isElectron && isMacPlatform(navigator.platform) && !fullscreen;
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/^\/layout(?=\/|$)/, "") || "/",
  });
  const settingsOpen = pathname === "/settings" || pathname.startsWith("/settings/");
  const navigate = useNavigate();
  const lastActiveBot = useLastActiveBot();
  const botOpen = pathname === "/bots" || pathname.startsWith("/bots/");
  const bots = useBots();
  const showSidebarControl = section !== "bots" || bots.length > 1;
  const href = useLocation({ select: (location) => location.href });
  const projects = useProjects();
  const threads = useThreadShells();
  const botThreads = useBotThreadShells();
  const botStatus = resolveNavigationStatus(botThreads);
  const threadStatus = resolveNavigationStatus(threads);
  const drafts = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const [lastThreadHref, setLastThreadHref] = useLocalStorage(
    "alternate-last-thread-href",
    null,
    lastThreadHrefSchema,
  );
  const threadHref = resolveThreadsNavigationHref({
    rememberedHref: lastThreadHref,
    projects,
    threads,
    drafts,
  });
  const currentThreadHref = resolveThreadsNavigationHref({
    rememberedHref: href,
    projects,
    threads,
    drafts,
  });
  useEffect(() => {
    if (currentThreadHref !== "/" && currentThreadHref === href && lastThreadHref !== href)
      setLastThreadHref(href);
  }, [href, currentThreadHref, lastThreadHref, setLastThreadHref]);
  const pullRequestsSupported = usePullRequestsSupported();
  return (
    <nav
      aria-label="Main navigation"
      data-app-sidebar={sidebarVisible ? "" : undefined}
      data-traffic-lights={reserveTrafficLights}
      data-thread-sidebar-open={sidebarVisible}
      className="alternate-navigation-rail z-40 flex w-12 shrink-0 flex-col items-center gap-2 pb-2 [-webkit-app-region:no-drag]"
    >
      <div className="flex h-[var(--workspace-topbar-height)] w-full shrink-0 items-center justify-center">
        {!reserveTrafficLights && !settingsOpen && showSidebarControl ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger
                  aria-label={sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
                />
              }
            />
            <TooltipPopup side="right">
              {sidebarVisible ? "Collapse sidebar" : "Expand sidebar"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <NavigationButton
        label="Bots"
        render={
          lastActiveBot ? (
            <Link
              to="/bots/$environmentId/$threadId"
              params={{
                environmentId: lastActiveBot.ownerEnvironmentId,
                threadId: lastActiveBot.threadId,
              }}
            />
          ) : (
            <Link to="/bots" />
          )
        }
        aria-current={botOpen ? "page" : undefined}
      >
        <NavigationStatusIcon status={botStatus}>
          <BotIcon />
        </NavigationStatusIcon>
      </NavigationButton>
      <NavigationButton
        label="Threads"
        onClick={() => void navigate({ href: threadHref })}
        aria-current={
          !botOpen && !settingsOpen && pathname !== "/usage" && pathname !== "/pull-requests"
            ? "page"
            : undefined
        }
      >
        <NavigationStatusIcon status={threadStatus}>
          <MessagesSquareIcon />
        </NavigationStatusIcon>
      </NavigationButton>
      {pullRequestsSupported ? (
        <NavigationButton
          label="Pull requests"
          render={<Link to="/pull-requests" search={readPullRequestListPreferences()} />}
          aria-current={pathname === "/pull-requests" ? "page" : undefined}
        >
          <PullRequestGlyph.pullRequest />
        </NavigationButton>
      ) : null}
      <div className="flex-1" />
      <NavigationButton
        label="Usage"
        render={<Link to="/usage" />}
        aria-current={pathname === "/usage" ? "page" : undefined}
      >
        <ChartNoAxesColumnIcon />
      </NavigationButton>
      <div className="flex w-full min-w-0 flex-col items-center gap-2">
        <SidebarMenu className="w-auto">
          <SidebarUpdatePill availableOnly presentation="icon" />
        </SidebarMenu>
        <NavigationButton
          label="Settings"
          render={<Link to="/settings" />}
          aria-current={settingsOpen ? "page" : undefined}
        >
          <SettingsIcon />
        </NavigationButton>
      </div>
    </nav>
  );
}
