import type { NavigationSection } from "./navigation.logic";
import { ThreadUndoShortcut } from "../AppSidebarLayout";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useWindowFullscreen } from "../../hooks/useWindowFullscreen";
import { getLocalStorageItem, removeLocalStorageItem } from "../../hooks/useLocalStorage";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
import { cn, isMacPlatform } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../../panelAnimations";
import { useThreadVisitedMigration } from "../../hooks/useThreadVisitedMigration";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { SidebarBrandWidthProbe } from "../sidebar/SidebarChrome";
import { AlternateSidebarHeader } from "./AlternateSidebarHeader";
import { MainAppLocationTracker } from "../sidebar/mainAppLocation";
import { useProjects } from "../../state/entities";
import { useBots } from "../../state/bots";
import {
  clampThreadSidebarWidth,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
} from "../threadSidebarWidth";
import { Sidebar, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "alternate_thread_sidebar_width";

const MACOS_TRAFFIC_LIGHTS_LEFT_INSET = "var(--desktop-window-controls-inset, 90px)";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl({ showButton = true }: { showButton?: boolean }) {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar, isMobile, mobileSheetMounted } = useSidebar();
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    window.addEventListener("keydown", onKeyDown, true);
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === "sidebar.toggle") toggleSidebar();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      unsubscribe?.();
    };
  }, [keybindings, toggleSidebar, usagePageOpen]);

  if (!showButton) return null;

  return (
    <div
      className={cn(
        "pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center",
        isMobile && mobileSheetMounted && "hidden",
      )}
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              variant="ghost"
              className="pointer-events-auto"
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useThreadRouteRef();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                routeThreadRef,
              ).terminalOpen
            : false,
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  return null;
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

export function AlternateSidebarFrame({
  children,
  threadSidebar,
  botSidebar,
  navigationRail,
  section,
}: {
  children: ReactNode;
  threadSidebar: ReactNode;
  botSidebar: ReactNode;
  navigationRail: ReactNode;
  section: NavigationSection;
}) {
  const navigate = useNavigate();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  useThreadVisitedMigration();
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/^\/layout(?=\/|$)/, "") || "/",
  });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const isBot = section === "bots";
  const bots = useBots();
  const showThreadSidebar = isOnSettings || !isBot || bots.length > 1;
  const [threadSidebarOpen, setThreadSidebarOpen] = useState(true);
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const [brandWidth, setBrandWidth] = useState(0);
  const sidebarMinimumWidth = resolveThreadSidebarMinimumWidth(brandWidth);
  const navigationRailWidth = navigationRail ? 48 : 0;
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(
    viewportWidth - navigationRailWidth,
    sidebarMinimumWidth,
  );
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  const isWindowFullscreen = useWindowFullscreen();
  const windowControlsInsetStyle = (
    isMacosDesktop && !isWindowFullscreen
      ? { "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_LEFT_INSET }
      : {}
  ) as CSSProperties;
  const sidebarProviderStyle = {
    "--alternate-rail-dark-surface":
      "color-mix(in oklab, var(--background) 90%, var(--primary) 10%)",
    "--sidebar-width": `${clampThreadSidebarWidth(sidebarWidth, sidebarMinimumWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
    ...windowControlsInsetStyle,
    ...(navigationRail
      ? {
          "--workspace-titlebar-content-left":
            isMacosDesktop && !isWindowFullscreen
              ? !showThreadSidebar
                ? "calc(var(--workspace-controls-left) - 3rem)"
                : "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap) - 3rem)"
              : "0.75rem",
        }
      : {}),
    ...(navigationRail && !(isMacosDesktop && !isWindowFullscreen)
      ? { "--workspace-controls-left": "0.5rem" }
      : {}),
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
        open={isOnSettings || (showThreadSidebar && threadSidebarOpen)}
        onOpenChange={(open) => {
          if (!isOnSettings && showThreadSidebar) setThreadSidebarOpen(open);
        }}
        style={sidebarProviderStyle}
      >
        {navigationRail}
        <SidebarBrandWidthProbe onWidthChange={setBrandWidth} />
        <ProjectProjectionRetention />
        {showThreadSidebar ? (
          <Sidebar
            side="left"
            collapsible="offcanvas"
            data-app-sidebar=""
            role="navigation"
            aria-label={isOnSettings ? "Settings" : isBot ? "Bots" : "Threads"}
            className={
              navigationRail
                ? "left-12 group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:left-[calc(3rem-var(--sidebar-width))]"
                : undefined
            }
            resizable={{
              maxWidth: sidebarMaximumWidth,
              minWidth: sidebarMinimumWidth,
              shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
                nextWidth <= currentWidth ||
                wrapper.clientWidth - nextWidth - navigationRailWidth >=
                  THREAD_MAIN_CONTENT_MIN_WIDTH,
              storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
              onResize: setSidebarWidth,
            }}
            style={
              navigationRail
                ? ({
                    "--workspace-titlebar-content-left":
                      isMacosDesktop && !isWindowFullscreen
                        ? isOnSettings
                          ? "var(--workspace-controls-left)"
                          : "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))"
                        : "0.75rem",
                    "--workspace-controls-left":
                      isMacosDesktop && !isWindowFullscreen
                        ? `calc(${MACOS_TRAFFIC_LIGHTS_LEFT_INSET} - 3rem)`
                        : "0.75rem",
                  } as CSSProperties)
                : windowControlsInsetStyle
            }
          >
            {isOnSettings ? (
              <>
                <AlternateSidebarHeader />
                <SettingsSidebarNav pathname={pathname} />
              </>
            ) : isBot ? (
              botSidebar
            ) : (
              threadSidebar
            )}
            {!isOnSettings ? <SidebarRail onDoubleClick={resetSidebarWidth} /> : null}
          </Sidebar>
        ) : null}
        {children}
        {!isOnSettings && showThreadSidebar ? (
          <SidebarControl showButton={!navigationRail || (isMacosDesktop && !isWindowFullscreen)} />
        ) : null}
        <NavigationHistoryShortcuts />
        {isOnSettings ? null : <ThreadUndoShortcut />}
        <MainAppLocationTracker />
      </SidebarProvider>
    </PanelAnimationSuppressionProvider>
  );
}
