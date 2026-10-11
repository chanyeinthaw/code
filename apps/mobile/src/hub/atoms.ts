import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";
import { HubConnection } from "./connection";

export const hubUrlAtom = connectionAtomRuntime.atom(
  Stream.unwrap(HubConnection.pipe(Effect.map((hub) => hub.urls))),
);
export const disconnectHub = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:hub:disconnect",
  execute: () => HubConnection.pipe(Effect.flatMap((hub) => hub.disconnect)),
});
