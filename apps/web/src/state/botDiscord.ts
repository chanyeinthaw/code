import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@satslab/client-runtime/state/runtime";
import { WS_METHODS } from "@satslab/contracts";
import { connectionAtomRuntime } from "../connection/runtime";

export const botDiscordStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "bots:discord:get",
  tag: WS_METHODS.botsDiscordGet,
  staleTimeMs: 1000,
  refreshIntervalMs: 5000,
});

export const botDiscordConfigure = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:discord:configure",
  tag: WS_METHODS.botsDiscordConfigure,
});

export const botDiscordSetCredential = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "bots:discord:setCredential",
  tag: WS_METHODS.botsDiscordSetCredential,
});
