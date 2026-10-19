import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/memory/$environmentId/$threadId")({
  component: () => null,
});
