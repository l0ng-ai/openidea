/**
 * The pull request timeline editor tab (IntelliJ's `GHPRTimelineVirtualFile`): its input,
 * title (`{title} #N` once the details are known, else `#N`) and state icon.
 */
import { editorService, maybeEditorService, type EditorInput } from "@/workbench/contributions";
import type { GHRepositoryCoordinates } from "../api/types";
import { pullRequestStateIcon } from "../data/model";
import { cachedDetails } from "../data/pullRequest";
import { requireConnection, sameRepository, useGhRepository } from "../data/repository";

export const TIMELINE_KIND = "github.timeline";

/** `input.data` of a timeline tab. */
export interface TimelineInputData extends GHRepositoryCoordinates {
  number: number;
}

export function timelineInput(repo: GHRepositoryCoordinates, number: number): EditorInput {
  const data: TimelineInputData = { owner: repo.owner, name: repo.name, number };
  return { kind: TIMELINE_KIND, key: `${TIMELINE_KIND}:${repo.owner}/${repo.name}#${number}`, data };
}

/** The timeline tab's data, or null for another kind of input. */
export function timelineData(input: EditorInput | null | undefined): TimelineInputData | null {
  if (input?.kind !== TIMELINE_KIND) return null;
  const d = input.data as Partial<TimelineInputData> | undefined;
  return d && typeof d.number === "number" && typeof d.owner === "string" && typeof d.name === "string"
    ? (d as TimelineInputData)
    : null;
}

/** The details when the tab is of the connected repository and they are loaded. */
function detailsOf(input: EditorInput) {
  const d = timelineData(input);
  if (!d || !sameRepository(useGhRepository.getState().connection?.coordinates, d)) return undefined;
  return cachedDetails(d.number);
}

export function timelineTitle(input: EditorInput): string {
  const d = timelineData(input);
  const details = detailsOf(input);
  return details ? `${details.title} #${d!.number}` : `#${d?.number ?? "?"}`;
}

export function timelineIcon(input: EditorInput): string {
  const details = detailsOf(input);
  return details ? pullRequestStateIcon(details.state, details.isDraft) : "github-timeline";
}

/** "View Timeline": opens the timeline of `number` of the connected repository (`focus`: like a file open). */
export async function openTimeline(number: number, opts: { focus?: boolean } = {}): Promise<void> {
  const repo = requireConnection().coordinates;
  await editorService().openInput(timelineInput(repo, number), { focus: opts.focus ?? true });
}

/** The pull request whose timeline is the active editor tab, when it is of the connected repository. */
export function activeTimelinePullRequest(): number | null {
  const d = timelineData(maybeEditorService()?.activeInput?.() ?? null);
  return d && sameRepository(useGhRepository.getState().connection?.coordinates, d) ? d.number : null;
}
