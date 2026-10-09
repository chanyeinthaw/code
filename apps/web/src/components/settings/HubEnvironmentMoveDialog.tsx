import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function HubEnvironmentMoveDialog({
  environment,
  onClose,
  onMoved,
}: {
  environment: { label: string; path: string } | null;
  onClose: () => void;
  onMoved: () => void;
}) {
  const [hubUrl, setHubUrl] = useState("");
  const [invitation, setInvitation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function move() {
    if (!environment || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(environment.path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hubUrl: hubUrl.trim(), environmentInvitation: invitation.trim() }),
      });
      if (!response.ok)
        throw new Error("Could not move the environment. Check the hub URL and invitation.");
      onMoved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not move the environment.");
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open={environment !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup
        className="max-w-md"
        aria-describedby={undefined}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (hubUrl.trim() && invitation.trim()) void move();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Move {environment?.label ?? "environment"} to hub</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <label htmlFor="environment-destination-hub" className="text-xs font-medium">
              Hub URL
            </label>
            <Input
              id="environment-destination-hub"
              type="url"
              autoFocus
              required
              value={hubUrl}
              disabled={pending}
              placeholder="https://hub.example.com"
              onChange={(event) => {
                setHubUrl(event.target.value);
                setError(null);
              }}
            />
            <label htmlFor="environment-destination-invitation" className="text-xs font-medium">
              Environment invitation
            </label>
            <Input
              id="environment-destination-invitation"
              required
              autoComplete="off"
              value={invitation}
              disabled={pending}
              placeholder="Invitation from the destination hub"
              onChange={(event) => {
                setInvitation(event.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="submit" disabled={pending || !hubUrl.trim() || !invitation.trim()}>
            {pending ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
