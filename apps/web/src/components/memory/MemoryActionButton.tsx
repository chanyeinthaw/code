import { useAtomValue } from "@effect/atom-react";
import type { ComponentProps } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { memoryCreate, memoryTransferActivate } from "../../state/memories";
import { Button } from "../ui/button";

export function MemoryActionButton({
  environmentId,
  destinationEnvironmentId,
  ...props
}: {
  environmentId: EnvironmentId;
  destinationEnvironmentId?: EnvironmentId;
} & ComponentProps<typeof Button>) {
  const sourceAllowed = useAtomValue(memoryCreate.permissionAtom(environmentId));
  const destinationAllowed = useAtomValue(
    memoryTransferActivate.permissionAtom(destinationEnvironmentId ?? environmentId),
  );
  return <Button {...props} disabled={props.disabled || !sourceAllowed || !destinationAllowed} />;
}
