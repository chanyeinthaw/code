import { createFileRoute, redirect } from "@tanstack/react-router";
import { BotSettingsPage } from "../components/bots/BotSettingsPage";

export const Route = createFileRoute("/bots/settings/$environmentId/$botId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: BotSettingsRoute,
});

function BotSettingsRoute() {
  return <BotSettingsPage {...Route.useParams()} />;
}
