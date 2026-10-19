import { createFileRoute } from "@tanstack/react-router";
import { BotManagementPanel } from "../components/bots/BotManagementPanel";

export const Route = createFileRoute("/settings/bots")({
  component: BotManagementPanel,
});
