import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/bots/$environmentId/$threadId")({
  component: () => null,
});
