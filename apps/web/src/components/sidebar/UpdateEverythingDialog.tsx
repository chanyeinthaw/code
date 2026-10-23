import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@satslab/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "~/state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { getDesktopUpdateReleaseUrl } from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";
import type { RestartingMachine, SkippedMachine } from "./updateEverything.logic";

const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly desktopVersion: string | null;
  readonly onConfirm: () => void;
}

export function UpdateEverythingDialog({
  open,
  onOpenChange,
  ...content
}: UpdateEverythingDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        {}
        <UpdateEverythingDialogContent {...content} />
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function UpdateEverythingDialogContent({
  summary,
  lines,
  restarts,
  skipped,
  desktopVersion,
  onConfirm,
}: Omit<UpdateEverythingDialogProps, "open" | "onOpenChange">) {
  const stopped = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => !machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const continuing = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const running = stopped + continuing;
  const threads = `${running} running ${running === 1 ? "thread" : "threads"}`;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{summary}?</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-line">
          {lines.join("\n")}
        </AlertDialogDescription>
        {running > 0 ? (
          <p className="pt-2 text-sm">
            {stopped === 0
              ? `${threads} will be interrupted and can resume after the restart.`
              : continuing === 0
                ? `${threads} will be interrupted.`
                : `${threads} will be interrupted. ${continuing} can resume after the restart.`}
          </p>
        ) : null}
        {skipped.length > 0 ? (
          <p className="whitespace-pre-line pt-2 text-sm">
            {skipped.map((machine) => `Skips ${machine.label}: ${machine.reason}`).join("\n")}
          </p>
        ) : null}
        {desktopVersion !== null ? <DesktopDownloadNotice version={desktopVersion} /> : null}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button onClick={onConfirm}>Update</Button>
      </AlertDialogFooter>
    </>
  );
}

// Self-updates are disabled, so a newer desktop app is a manual download from its release page.
function DesktopDownloadNotice({ version }: { readonly version: string }) {
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  if (releaseUrl === null) return null;
  return (
    <p className="flex items-center gap-2 pt-2 text-sm">
      Sora desktop {version}
      <Button
        size="xs"
        variant="outline"
        onClick={() => void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl)}
      >
        Download
      </Button>
    </p>
  );
}
