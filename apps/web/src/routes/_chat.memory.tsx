import { createFileRoute } from "@tanstack/react-router";
import { MemoryChatPage } from "../components/memory/MemoryChatPage";
export const Route = createFileRoute("/_chat/memory")({
  validateSearch: (search: Record<string, unknown>): { manage?: boolean } =>
    search.manage === true ? { manage: true } : {},
  component: MemoryChatPage,
});
