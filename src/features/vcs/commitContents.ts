import type { CommitSelection, FileStatus, PartialCommitFile } from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands, isErrorKind, nextRequestId } from "@/platform/ipc";
import { renamedFromPath } from "./changes";
import { readDiffSide, revisionChangeDiffData, type DiffData } from "./diffInput";
import { stripSlash } from "./model";
import { GITLINK_MODE, loadDiffEntries } from "./gitDiffEntries";

const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n");

interface CommitFile {
  path: string;
  basePath: string;
  source: "staged" | "partial" | "working";
  blocks?: PartialCommitFile;
}

export function commitFiles(files: readonly FileStatus[], selection: CommitSelection): CommitFile[] {
  const options = selection.repositories.map((repo) => repo.options);
  const stage = new Set(options.flatMap((option) => option.stage ?? []).map(stripSlash));
  const partial = new Map(
    options.flatMap((option) => option.partial ?? []).map((file) => [stripSlash(file.path), file]),
  );
  return files.flatMap((file) => {
    const path = stripSlash(file.path);
    const blocks = partial.get(path);
    const source = blocks ? "partial" : stage.has(path) ? "working" : "staged";
    if ((source === "staged" ? file.staged : file.unstaged) === "deleted") return [];
    return [{ path, basePath: renamedFromPath(file) ?? path, source, blocks }];
  });
}

function readWorkingText(path: string): Promise<string> {
  return call(commands.fsReadText(path));
}

export function workingText(path: string): Promise<string | null> {
  return readWorkingText(path)
    .then(normalizeLineEndings)
    .catch(() => null);
}

export type SnapshotText =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "nonText" }
  | { kind: "unavailable"; error: unknown };

export async function readSnapshotText(read: Promise<string | null>): Promise<SnapshotText> {
  try {
    const text = await read;
    if (text === null) return { kind: "absent" };
    if (text.includes("\0")) return { kind: "nonText" };
    return { kind: "text", text: normalizeLineEndings(text) };
  } catch (error) {
    if (isErrorKind(error, "cancelled") || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return { kind: "unavailable", error };
  }
}

async function readSelectedText(path: string, rev: string, read: Promise<string | null>): Promise<SnapshotText> {
  const result = await readSnapshotText(read);
  // VCS blob reads return no text for a submodule entry. Its worktree is a directory.
  if (result.kind === "absent" || result.kind === "unavailable") {
    const entries = await loadDiffEntries([{ path, rev }]);
    if (entries?.[0]?.mode === GITLINK_MODE) return { kind: "nonText" };
  }
  return result;
}

interface CommitSnapshot {
  before: SnapshotText;
  content: string;
  revision: string;
  text: string;
}

type CommitFileRead =
  | { kind: "ready"; snapshot: CommitSnapshot }
  | { kind: "nonText" | "absent" }
  | { kind: "unavailable"; error: unknown };

export async function readCommitFile(file: CommitFile, amend: boolean): Promise<CommitFileRead> {
  const { path, basePath, source, blocks } = file;
  const revision = amend ? "HEAD~1" : "HEAD";
  const [before, current] = await Promise.all([
    readSnapshotText(call(commands.vcsFileAt(basePath, revision))),
    source === "staged"
      ? readSelectedText(path, ":0", call(commands.vcsFileAt(path, ":0")))
      : readSelectedText(path, "WT", readWorkingText(path)),
  ]);
  if (current.kind !== "text") return current;
  const content = current.text;
  if (!blocks) return { kind: "ready", snapshot: { before, content, revision, text: content } };
  const prepared = await readSnapshotText(call(commands.vcsPreviewPartialCommit(blocks)));
  if (prepared.kind === "unavailable" && isErrorKind(prepared.error, "invalidInput")) {
    throw new Error(tx("Selected changes moved. Review the file and run checks again."), { cause: prepared.error });
  }
  if (prepared.kind !== "text") return prepared;
  return { kind: "ready", snapshot: { before, content, revision, text: prepared.text } };
}

export function commitFileDiff(file: CommitFile, { before, revision, text }: CommitSnapshot, line: number): DiffData {
  return {
    path: file.path,
    left: {
      type: "text",
      text: before.kind === "text" ? before.text : "",
      label: revision,
      absent: before.kind === "absent",
    },
    right: { type: "text", text, label: file.source === "staged" ? tx("Staged (index)") : tx("Selected Changes") },
    line,
  };
}

export interface CommittedSnapshot {
  diff: DiffData;
  read(): Promise<SnapshotText>;
}

export async function committedSnapshots(repo: string, commits: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const request = nextRequestId();
  const cancel = () => void commands.cancelRequest(request).catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const changes = await call(commands.vcsCommitSelectionChanges(repo, commits, request)).finally(() =>
    signal.removeEventListener("abort", cancel),
  );
  const tip = commits.at(-1)!;
  return changes.flatMap<CommittedSnapshot>((file) => {
    if (!file.after || file.link) return [];
    const diff = revisionChangeDiffData({ ...file, after: tip }, repo);
    let text: Promise<SnapshotText> | undefined;
    return [
      {
        diff,
        read: () => {
          signal.throwIfAborted();
          return (text ??= readSelectedText(diff.path, tip, readDiffSide(diff.path, diff.right)));
        },
      },
    ];
  });
}

export async function collectSnapshotResults<T, R>(
  sources: readonly T[],
  inspect: (source: T) => Promise<R | null>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < sources.length; i += 4) {
    for (const result of await Promise.all(sources.slice(i, i + 4).map(inspect))) {
      if (result !== null) results.push(result);
    }
  }
  return results;
}
