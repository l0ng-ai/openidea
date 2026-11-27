import type { PushRefResult, PushReport } from "@/bindings";
import { tx } from "@/platform/i18n";
import { IpcError } from "@/platform/ipc";
import { repoName } from "./store";

export interface RepoPushOutcome {
  repo: string | null;
  lines: string[];
}

export function partialPushReport(error: unknown): PushReport | null {
  if (!(error instanceof IpcError)) return null;
  const data = error.data;
  return data?.type === "pushPartiallyApplied" || data?.type === "pushRejected" ? (data.report ?? null) : null;
}

export function formatPushOutcomes(outcomes: readonly RepoPushOutcome[], showRepo: boolean): string[] {
  return outcomes.flatMap(({ repo, lines }) =>
    showRepo && repo ? lines.map((line) => `${repoName(repo)}: ${line}`) : lines,
  );
}

export const pushedCommits = (n: number, remote: string) =>
  n === 1 ? tx`Pushed ${n} commit to ${remote}` : tx`Pushed ${n} commits to ${remote}`;

export function describePush(report: PushReport): string[] {
  if (!report.refs.length) return [tx("Push successful")];

  const updates = new Map<string, PushRefResult[]>();
  for (const result of report.refs) {
    if (result.status === "upToDate") continue;
    const refs = updates.get(result.reference);
    if (refs) refs.push(result);
    else updates.set(result.reference, [result]);
  }

  const lines: string[] = [];
  const tags: string[] = [];
  for (const [ref, refs] of updates) {
    const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    const to = report.remote ? `${report.remote}/${branch ?? ref}` : (branch ?? ref);
    const { status, commits } = refs[0]!;
    if (ref.startsWith("refs/tags/") && refs.every((update) => update.status !== "deleted")) {
      tags.push(ref.slice("refs/tags/".length));
    } else if (!refs.every((update) => update.status === status)) {
      // One remote can have several push URLs and Git can report different changes for the same ref.
      lines.push(tx`Pushed to ${to}`);
    } else if (status === "created" && branch) {
      lines.push(tx`Pushed to new branch ${to}`);
    } else if (status === "forced") {
      lines.push(tx`Force pushed to ${to}`);
    } else if (status === "deleted") {
      lines.push(tx`Deleted remote ref ${to}`);
    } else if (commits && refs.every((update) => update.commits === commits)) {
      lines.push(pushedCommits(commits, to));
    } else {
      lines.push(tx`Pushed to ${to}`);
    }
  }

  const remote = report.remote;
  if (tags.length === 1) {
    const tag = tags[0]!;
    lines.push(remote ? tx`Pushed tag ${tag} to ${remote}` : tx`Pushed tag ${tag}`);
  } else if (tags.length > 1) {
    const count = tags.length;
    lines.push(remote ? tx`Pushed ${count} tags to ${remote}` : tx`Pushed ${count} tags`);
  }
  return lines.length ? lines : [tx("Everything is up to date")];
}
