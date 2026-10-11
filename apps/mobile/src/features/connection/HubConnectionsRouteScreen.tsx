import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { AppText } from "../../components/AppText";
import { hubUrlAtom, disconnectHub } from "../../hub/atoms";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { ConnectionStatusDot } from "./ConnectionStatusDot";
import { GitHubRoutingSettings } from "./GitHubRoutingSettings";

export function HubConnectionsRouteScreen() {
  const navigation = useNavigation();
  const hub = useAtomValue(hubUrlAtom);
  const disconnect = useAtomCommand(disconnectHub, { reportFailure: true });
  const { connectedEnvironments } = useRemoteConnections();
  const url = AsyncResult.isSuccess(hub) ? hub.value : null;
  return (
    <ScreenScrollView
      className="flex-1 bg-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 20 }}
    >
      <SettingsSection title="Hub">
        {url ? (
          <AppText className="px-4 pt-4 text-base" selectable>
            {url}
          </AppText>
        ) : null}
        <SettingsActionRow
          icon="globe"
          label={url ? "Switch hub" : "Connect to hub"}
          onPress={() => navigation.navigate("ConnectionsNew")}
        />
        {url ? (
          <SettingsActionRow
            icon="xmark.circle.fill"
            label="Disconnect"
            onPress={() => {
              void disconnect(undefined);
            }}
          />
        ) : null}
      </SettingsSection>
      {connectedEnvironments.length > 0 ? (
        <SettingsSection title="Environments">
          {connectedEnvironments.map((environment) => (
            <View
              key={environment.environmentId}
              className="flex-row items-center gap-3 px-4 py-3.5"
            >
              <ConnectionStatusDot state={environment.connectionState} pulse={false} size={8} />
              <AppText className="flex-1 text-base">{environment.environmentLabel}</AppText>
            </View>
          ))}
        </SettingsSection>
      ) : null}
      <GitHubRoutingSettings />
    </ScreenScrollView>
  );
}
