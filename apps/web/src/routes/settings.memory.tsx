import { createFileRoute } from "@tanstack/react-router";
import { MemoryManagementPanel } from "../components/memory/MemoryManagementPanel";

export const Route = createFileRoute("/settings/memory")({
  component: MemoryManagementPanel,
});
