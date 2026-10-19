import { useLastActiveMemory, useMemories } from "../../state/memories";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  MessagesSquareIcon,
  GitBranchIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
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
import { MemorySidebar } from "../memory/MemorySidebar";
import { Button } from "../ui/button";
import { SidebarFooter, SidebarMenu, SidebarTrigger, useSidebarVisibility } from "../ui/sidebar";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AlternateSidebarLayout({ children }: { children: ReactNode }) {
  return (
    <AlternateSidebarFrame
      navigationRail={<AlternateNavigationRail />}
      memorySidebar={<MemorySidebar />}
      threadSidebar={
        <>
          <AlternateSidebarHeader />
          <Sidebar presentation="alternate" />
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

function AlternateSidebarFooter() {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
    </SidebarFooter>
  );
}

function AlternateNavigationRail() {
  const sidebarVisible = useSidebarVisibility();
  const fullscreen = useWindowFullscreen();
  const reserveTrafficLights = isElectron && isMacPlatform(navigator.platform) && !fullscreen;
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/^\/layout(?=\/|$)/, "") || "/",
  });
  const settingsOpen = pathname === "/settings" || pathname.startsWith("/settings/");
  const isUtilityPage = pathname === "/usage" || pathname === "/pull-requests";
  const navigate = useNavigate();
  const lastActiveMemory = useLastActiveMemory();
  const memoryOpen = pathname === "/memory" || pathname.startsWith("/memory/");
  const memories = useMemories();
  const showSidebarControl = !memoryOpen || memories.length > 1;
  const href = useLocation({ select: (location) => location.href });
  const lastThreadHref = useRef<string | null>(null);
  useEffect(() => {
    if (!memoryOpen && !settingsOpen && !isUtilityPage) lastThreadHref.current = href;
  }, [href, memoryOpen, settingsOpen, isUtilityPage]);
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
        {!reserveTrafficLights && !settingsOpen && !isUtilityPage && showSidebarControl ? (
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
        label="Chat"
        render={
          lastActiveMemory ? (
            <Link
              to="/memory/$environmentId/$threadId"
              params={{
                environmentId: lastActiveMemory.ownerEnvironmentId,
                threadId: lastActiveMemory.threadId,
              }}
            />
          ) : (
            <Link to="/memory" />
          )
        }
        aria-current={memoryOpen ? "page" : undefined}
      >
        <GitBranchIcon />
      </NavigationButton>
      <NavigationButton
        label="Threads"
        onClick={() => void navigate({ href: lastThreadHref.current ?? "/" })}
        aria-current={
          !memoryOpen && !settingsOpen && pathname !== "/usage" && pathname !== "/pull-requests"
            ? "page"
            : undefined
        }
      >
        <MessagesSquareIcon />
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
          <SidebarUpdatePill availableOnly />
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
