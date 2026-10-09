import { HubLocalEnvironmentState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const decodeState = Schema.decodeUnknownSync(HubLocalEnvironmentState);

export function HubLocalEnvironmentSetting({
  canManage,
  onChanged,
}: {
  canManage: boolean;
  onChanged: () => void;
}) {
  const [state, setState] = useState<HubLocalEnvironmentState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      void fetch("/hub/local-environment", { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not read local environment.");
          setState(decodeState(await response.json()));
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("Could not read local environment.");
        });
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pulse:environment-moved", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pulse:environment-moved", refresh);
    };
  }, []);
  if (!state?.supported)
    return error ? <SettingsRow title="Local environment" description={error} /> : null;
  const enabled = state.enabled;

  const applyChange = async () => {
    setIsUpdating(true);
    setError(null);
    try {
      const response = await fetch("/hub/local-environment", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!response.ok) throw new Error("Could not change local environment.");
      setState(decodeState(await response.json()));
      setConfirmOpen(false);
      onChanged();
      window.dispatchEvent(new Event("pulse:environment-moved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("hub-local-environment")}
        description={
          enabled
            ? "Run agents in this installation’s environment."
            : "Turned off. The client and hub remain available."
        }
        control={
          <Switch
            checked={enabled}
            disabled={isUpdating || !canManage}
            onCheckedChange={() => setConfirmOpen(true)}
            aria-label="Local environment"
          />
        }
      />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (isUpdating) return;
          setConfirmOpen(open);
          if (!open) setError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {enabled ? "Turn off local environment?" : "Turn on local environment?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {enabled
                ? "This installation’s running agents and terminals will stop. The client and hub will keep running. Separately running environments are unaffected."
                : "Start this installation’s environment using its saved hub connection."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant={enabled ? "destructive" : "default"}
              disabled={isUpdating}
              onClick={() => void applyChange()}
            >
              {isUpdating
                ? enabled
                  ? "Stopping…"
                  : "Starting…"
                : enabled
                  ? "Turn off"
                  : "Turn on"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
