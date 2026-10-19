import { useAtomValue } from "@effect/atom-react";
import type { ComponentProps } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { botCreate, botTransferActivate } from "../../state/bots";
import { Button } from "../ui/button";

export function BotActionButton({
  environmentId,
  destinationEnvironmentId,
  ...props
}: {
  environmentId: EnvironmentId;
  destinationEnvironmentId?: EnvironmentId;
} & ComponentProps<typeof Button>) {
  const sourceAllowed = useAtomValue(botCreate.permissionAtom(environmentId));
  const destinationAllowed = useAtomValue(
    botTransferActivate.permissionAtom(destinationEnvironmentId ?? environmentId),
  );
  return <Button {...props} disabled={props.disabled || !sourceAllowed || !destinationAllowed} />;
}
