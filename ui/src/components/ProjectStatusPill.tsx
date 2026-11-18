import type { Project, ProjectDerivedStatus } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";

/** Label and badge colour for each derived project status. */
const PROJECT_PILL: Record<ProjectDerivedStatus, { label: string; badgeStatus: string }> = {
  not_started: { label: "Not started", badgeStatus: "backlog" },
  in_progress: { label: "In progress", badgeStatus: "in_progress" },
  done: { label: "Done", badgeStatus: "done" },
};

/**
 * The project's pill. It follows the project's tasks: the server derives it
 * (`derivedStatus`) next to `openTaskCount`, so the list and the project page
 * agree. The stored project status is not shown. Older servers send no
 * `derivedStatus`, so there is no pill.
 */
export function ProjectStatusPill({ project }: { project: Pick<Project, "derivedStatus"> }) {
  const pill = project.derivedStatus ? PROJECT_PILL[project.derivedStatus] : undefined;
  if (!pill) return null;
  return <StatusBadge data-testid="project-status-pill" status={pill.badgeStatus} label={pill.label} />;
}
