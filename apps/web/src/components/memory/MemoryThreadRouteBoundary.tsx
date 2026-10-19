import type { ScopedThreadRef } from "@t3tools/contracts";
import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useMemoryThreadContext } from "../../state/memories";
import { isThreadRoutePathname } from "../../threadRoutes";

export function MemoryThreadRouteBoundary({
  threadRef,
  children,
}: {
  threadRef: ScopedThreadRef | null;
  children: ReactNode;
}) {
  const memory = useMemoryThreadContext(threadRef);
  const pathname = useLocation({
    select: (location) => location.pathname.replace(/^\/layout(?=\/|$)/, "") || "/",
  });
  // Old bookmarks and app-owned thread links still use ordinary thread URLs.
  if (
    threadRef &&
    memory &&
    !pathname.startsWith("/memory/") &&
    isThreadRoutePathname(pathname, threadRef)
  ) {
    return (
      <Navigate to="/memory/$environmentId/$threadId" params={threadRef} search hash replace />
    );
  }
  return children;
}
