import { HubClientAccessState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const decodeState = Schema.decodeUnknownSync(HubClientAccessState);

export function HubClientAccessSetting({ canManage }: { canManage: boolean }) {
  const [requirePairing, setRequirePairing] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/hub/local-auth/client-access", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read client access.");
        setRequirePairing(decodeState(await response.json()).requirePairing);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not read client access.");
      });
    return () => controller.abort();
  }, []);
  async function update(next: boolean) {
    const previous = requirePairing;
    setRequirePairing(next);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/hub/local-auth/client-access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirePairing: next }),
      });
      if (!response.ok) throw new Error("Could not change client access.");
      setRequirePairing(decodeState(await response.json()).requirePairing);
      // Re-enabling pairing retires sessions that were granted without pairing.
      if (next) window.location.reload();
    } catch {
      setRequirePairing(previous);
      setError("Could not change client access.");
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsRow
      title="Require pairing"
      description={
        requirePairing === false
          ? "Anyone who can reach this served client has Admin access."
          : "Pair clients before granting access to this hub."
      }
      control={
        <Switch
          checked={requirePairing ?? true}
          disabled={!canManage || pending || requirePairing === null}
          onCheckedChange={(next) => void update(next)}
          aria-label="Require pairing"
        />
      }
    >
      {error ? (
        <p role="alert" className="pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
