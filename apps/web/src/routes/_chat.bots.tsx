import { createFileRoute } from "@tanstack/react-router";
import { BotChatPage } from "../components/bots/BotChatPage";
export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (search: Record<string, unknown>): { manage?: boolean } =>
    search.manage === true ? { manage: true } : {},
  component: BotChatPage,
});
