import { Link, useLocation } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, MessagesSquareIcon, SettingsIcon } from "lucide-react";
import { type ComponentProps, type ReactNode } from "react";
import { isElectron } from "../../env";
import { useWindowFullscreen } from "../../hooks/useWindowFullscreen";
import { isMacPlatform } from "../../lib/utils";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { usePullRequestsSupported } from "../../state/environments";
import { useNavigateToMainApp } from "../sidebar/mainAppLocation";
import { AlternateSidebarFrame } from "./AlternateSidebarFrame";
import { AlternateSidebarHeader } from "./AlternateSidebarHeader";
import { SidebarProviderUpdatePill } from "../sidebar/SidebarProviderUpdatePill";
import Sidebar from "../Sidebar";
import { Button } from "../ui/button";
import { SidebarFooter, SidebarMenu, SidebarTrigger, useSidebarVisibility } from "../ui/sidebar";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "../sidebar/SidebarUpdatePill";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function AlternateSidebarLayout({ children }: { children: ReactNode }) {
  return (
    <AlternateSidebarFrame
      navigationRail={<AlternateNavigationRail />}
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
  const navigateToMainApp = useNavigateToMainApp();
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
        {!reserveTrafficLights && !settingsOpen && !isUtilityPage ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarTrigger
                  aria-label={sidebarVisible ? "Collapse thread sidebar" : "Expand thread sidebar"}
                />
              }
            />
            <TooltipPopup side="right">
              {sidebarVisible ? "Collapse thread sidebar" : "Expand thread sidebar"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <NavigationButton
        label="Threads"
        onClick={() => void navigateToMainApp()}
        aria-current={
          !settingsOpen && pathname !== "/usage" && pathname !== "/pull-requests"
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
