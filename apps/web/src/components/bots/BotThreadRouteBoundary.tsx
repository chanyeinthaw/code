import type { ScopedThreadRef } from "@satslab/contracts";
import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useBotThreadContext } from "../../state/bots";
import { isThreadRoutePathname } from "../../threadRoutes";

export function BotThreadRouteBoundary({
  threadRef,
  children,
}: {
  threadRef: ScopedThreadRef | null;
  children: ReactNode;
}) {
  const bot = useBotThreadContext(threadRef);
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/^\/layout(?=\/|$)/, "") || "/",
  });
  // Old bookmarks and app-owned thread links still use ordinary thread URLs.
  if (
    threadRef &&
    bot &&
    !pathname.startsWith("/bots/") &&
    isThreadRoutePathname(pathname, threadRef)
  ) {
    return <Navigate to="/bots/$environmentId/$threadId" params={threadRef} search hash replace />;
  }
  return children;
}
