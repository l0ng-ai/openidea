import { projectFolder } from "@/platform/project";

/** Prefer the active file's member, then the last task's member, then manifest order. */
export function defaultTaskProject(
  project: Parameters<typeof projectFolder>[0],
  activePath: string | null,
  last: string | null | undefined,
): string | null {
  const members = project?.workspace?.projects;
  if (!members?.length) return project?.root ?? null;
  const active = activePath ? projectFolder(project, activePath)?.root : null;
  return active ?? (last && members.includes(last) ? last : (members[0] ?? null));
}
