import { AuthOrchestrationOperateScope, type ProjectIconOverride } from "@satslab/contracts";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@satslab/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { lazy, Suspense, useRef, useState } from "react";
import { useComposerMenuState } from "../chat/useComposerMenuState";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useEnvironmentsWithScope, readEnvironmentScope } from "../../state/session";
import {
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  canPickExternalProjectFavicon,
  ProjectFaviconPickerDialog,
} from "./ProjectFaviconPickerDialog";
import { projectGroupTitleNeedsUpdate } from "./ProjectSettingsPanel.logic";

const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then((module) => ({
    default: module.ProjectIconPickerDialog,
  })),
);

export function ProjectIdentitySettings({
  group,
  disabled = false,
}: {
  group: SidebarProjectSnapshot;
  disabled?: boolean;
}) {
  const iconLabel = group.memberProjects.some((member) => member.isBot)
    ? "Bot icon"
    : "Project icon";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const editableIds = useEnvironmentsWithScope(group.memberProjects, AuthOrchestrationOperateScope);
  const canEditGroup =
    !disabled && group.memberProjects.every((member) => editableIds.has(member.environmentId));
  const representative =
    group.memberProjects.find(
      (member) => environmentById.get(member.environmentId)?.serverConfig != null,
    ) ?? group.memberProjects[0]!;
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const projectNameEditedRef = useRef(false);

  const faviconPath = representative.faviconPath ?? null;
  const projectIcon = representative.projectIcon ?? null;
  const pickProjectFavicon =
    typeof window !== "undefined" &&
    group.memberProjects.every(
      (member) =>
        member.environmentId === primaryEnvironmentId &&
        canPickExternalProjectFavicon(member.workspaceRoot, navigator.platform),
    )
      ? window.desktopBridge?.pickProjectFavicon
      : undefined;

  const reportFailure = (title: string, result: AtomCommandResult<void, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const checkProjectAccess = (
    members: ReadonlyArray<SidebarProjectGroupMember>,
    failureTitle: string,
  ) => {
    const denied = members.find(
      (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
    );
    if (!denied) return null;
    const result = AsyncResult.failure<void, Error>(
      Cause.fail(
        new Error(
          `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
        ),
      ),
    );
    reportFailure(failureTitle, result);
    return result;
  };

  const updateAllMembers = async (
    input: Partial<{
      title: string;
      faviconPath: string | null;
      projectIcon: ProjectIconOverride | null;
    }>,
    failureTitle: string,
  ): Promise<AtomCommandResult<void, unknown>> => {
    const denied = checkProjectAccess(group.memberProjects, failureTitle);
    if (denied) return denied;
    const unavailable = group.memberProjects.find((member) => {
      const environment = environmentById.get(member.environmentId);
      return environment?.connection.phase !== "connected" || !environment.serverConfig;
    });
    if (unavailable) {
      const error = new Error(
        `Connect ${unavailable.environmentLabel ?? "the selected environment"} and try again.`,
      );
      const result: AtomCommandResult<void, unknown> = AsyncResult.failure(Cause.fail(error));
      reportFailure(failureTitle, result);
      return result;
    }
    for (const member of group.memberProjects) {
      const revoked = checkProjectAccess([member], failureTitle);
      if (revoked) return revoked;
      const result = mapAtomCommandResult(
        await updateProject({
          environmentId: member.environmentId,
          input: { projectId: member.id, ...input },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportFailure(
          group.memberProjects.length > 1
            ? `${failureTitle} on ${member.environmentLabel ?? "the current environment"}`
            : failureTitle,
          result,
        );
        return result;
      }
    }
    return AsyncResult.success(undefined);
  };

  const renameGroup = async (nextTitle: string, wasEdited: boolean) => {
    if (disabled) return;
    const title = nextTitle.trim();
    if (!title) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (
      !projectGroupTitleNeedsUpdate(
        group.memberProjects.map((member) => member.title),
        title,
        wasEdited,
      )
    ) {
      return;
    }
    await updateAllMembers({ title }, "Failed to rename project");
  };

  const [faviconPickerOpen, setFaviconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditGroup);
  const [isSavingFavicon, setIsSavingFavicon] = useState(false);
  const savingFaviconRef = useRef(false);
  const setProjectIcon = async (input: {
    faviconPath: string | null;
    projectIcon: ProjectIconOverride | null;
  }) => {
    if (!canEditGroup || savingFaviconRef.current) return;
    savingFaviconRef.current = true;
    setIsSavingFavicon(true);
    await updateAllMembers(input, "Failed to update project icon");
    savingFaviconRef.current = false;
    setIsSavingFavicon(false);
  };

  return (
    <>
      <SettingsSection id="project-overview" title="Project" hideTitle>
        {!canEditGroup ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            {group.memberProjects.length > 1
              ? "Shared settings require permission to change every checkout in this group."
              : "This connection cannot change this project."}
          </p>
        ) : null}
        <SettingsRow
          title="Name"
          description="The shared name for this project group in the sidebar and thread lists."
          control={
            <Input
              key={`${group.projectKey}:${group.displayName}`}
              size="sm"
              className="w-full sm:w-64"
              aria-label="Project name"
              disabled={!canEditGroup}
              defaultValue={group.displayName}
              onChange={() => {
                projectNameEditedRef.current = true;
              }}
              onBlur={(event) => {
                const wasEdited = projectNameEditedRef.current;
                projectNameEditedRef.current = false;
                void renameGroup(event.currentTarget.value, wasEdited);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
        <SettingsRow
          title={iconLabel}
          description={
            projectIcon?.kind === "lucide"
              ? `${projectIcon.name} · ${projectIcon.color}`
              : projectIcon?.kind === "monogram"
                ? `${projectIcon.text} · ${projectIcon.color}`
                : projectIcon?.kind === "emoji"
                  ? projectIcon.emoji
                  : (faviconPath ?? "Automatic")
          }
          resetAction={
            group.memberProjects.some(
              (member) => member.faviconPath != null || member.projectIcon != null,
            ) ? (
              <SettingResetButton
                label={iconLabel.toLowerCase()}
                disabled={isSavingFavicon || !canEditGroup}
                onClick={() => void setProjectIcon({ faviconPath: null, projectIcon: null })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <ProjectFavicon project={representative} className="size-6" />
              <Button
                size="sm"
                variant="outline"
                type="button"
                aria-label={`Choose a ${iconLabel.toLowerCase()}`}
                disabled={isSavingFavicon || !canEditGroup}
                onClick={() => setIconPickerOpen(true)}
              >
                Choose icon
              </Button>
              <Button
                size="sm"
                variant="outline"
                type="button"
                aria-label={`Choose a ${iconLabel.toLowerCase()} file`}
                disabled={isSavingFavicon || !canEditGroup}
                onClick={() => setFaviconPickerOpen(true)}
              >
                Choose file
              </Button>
            </div>
          }
        />
      </SettingsSection>
      <ProjectFaviconPickerDialog
        key={`${representative.environmentId}:${representative.workspaceRoot}:${faviconPickerOpen}`}
        cwd={representative.workspaceRoot}
        environmentId={representative.environmentId}
        onOpenChange={setFaviconPickerOpen}
        {...(pickProjectFavicon
          ? { onPickExternal: () => pickProjectFavicon(representative.workspaceRoot) }
          : {})}
        onSelect={(path) => void setProjectIcon({ faviconPath: path, projectIcon: null })}
        open={faviconPickerOpen && canEditGroup}
        projectName={group.displayName}
      />
      {iconPickerOpen && canEditGroup ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={projectIcon}
            projectName={representative.title}
            open
            onOpenChange={setIconPickerOpen}
            onSelect={(icon) => void setProjectIcon({ faviconPath: null, projectIcon: icon })}
          />
        </Suspense>
      ) : null}
    </>
  );
}
