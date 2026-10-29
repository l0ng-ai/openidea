/** Diff editor inputs and helpers to open them. */
import type { ChangedFile, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { baseName, effectiveKind } from "./model";
import { readWorkingText } from "./ops";
import { renamedFromPath } from "./changes";
import { currentRepoRoot, statusOf } from "./store";

export type DiffSide =
  /** File content at a git revision (`HEAD`, `:0` = index, a commit id, `<id>^`). */
  | { type: "rev"; rev: string; path?: string; label?: string }
  /** The working file (unsaved editor buffer included). */
  | { type: "worktree"; label?: string }
  /** Another file (Compare With…, Compare Files); editable like the working file. */
  | { type: "file"; path: string; label?: string }
  | { type: "text"; text: string; label: string }
  /** A Local History revision. */
  | { type: "history"; id: string; label: string };

/** A note attached below a line of one side (pull request review comments). */
export interface DiffAnnotation {
  side: "left" | "right";
  /** 0-based line of that side. */
  line: number;
  author: string;
  body: string;
  /** ISO date. */
  date?: string;
}

export interface DiffData {
  /** Absolute path of the file (the right side's path). */
  path: string;
  left: DiffSide;
  right: DiffSide;
  /** Reveal this 0-based line of the right side. */
  line?: number;
  /** Tab title instead of the default "name (left ↔ right)". */
  title?: string;
  /** Notes shown under lines (unified mode shows the right side's only). */
  annotations?: DiffAnnotation[];
  /**
   * The files of the change this diff belongs to (IDEA's diff request chain): F7 / Shift+F7
   * past the last / first difference move to the next / previous one. Entries carry no chain.
   */
  chain?: DiffData[];
  /** Select the first or last difference once shown (moving along the chain). */
  reveal?: "first" | "last";
}

export const DIFF_KIND = "diff";

export function sideKey(s: DiffSide): string {
  switch (s.type) {
    case "rev":
      return `rev:${s.rev}:${s.path ?? ""}`;
    case "worktree":
      return "wt";
    case "file":
      return `file:${s.path}`;
    case "text":
      return `text:${s.label}:${textHash(s.text)}`;
    case "history":
      return `hist:${s.id}`;
  }
}

/** Short content hash so different texts under one label get their own tab. */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function sideLabel(s: DiffSide): string {
  switch (s.type) {
    case "rev":
      if (s.label) return s.label;
      if (s.rev === "HEAD") return "HEAD";
      if (s.rev === ":0" || s.rev === ":") return "Staged (index)";
      return s.rev.length >= 40 ? s.rev.slice(0, 8) : s.rev;
    case "worktree":
      return s.label ?? "Your version";
    case "file":
      return s.label ?? s.path;
    case "text":
    case "history":
      return s.label;
  }
}

const diffKey = (data: DiffData) => `diff:${data.path}:${sideKey(data.left)}:${sideKey(data.right)}`;

export function diffInput(data: DiffData): EditorInput {
  return { kind: DIFF_KIND, key: diffKey(data), path: data.path, data };
}

/** `items` as a chain: each entry knows its siblings. */
export function withChain(items: readonly DiffData[], index: number): DiffData {
  const chain = items.length > 1 ? items.map(({ chain: _c, reveal: _r, ...d }) => d) : undefined;
  return { ...items[index]!, chain };
}

/** The neighbour of `data` in its chain (`dir` 1: next, -1: previous), revealing the nearest difference. */
export function chainNeighbour(data: DiffData, dir: 1 | -1): DiffData | null {
  const chain = data.chain;
  if (!chain) return null;
  const index = chain.findIndex((d) => diffKey(d) === diffKey(data));
  const next = index < 0 ? undefined : chain[index + dir];
  return next ? { ...next, chain, reveal: dir === 1 ? "first" : "last" } : null;
}

export function diffTitle(data: DiffData): string {
  if (data.title) return data.title;
  if (data.left.type === "file") return `${baseName(data.left.path)} ↔ ${baseName(data.path)}`;
  return `${baseName(data.path)} (${sideLabel(data.left)} ↔ ${sideLabel(data.right)})`;
}

export async function openDiff(data: DiffData, opts: { preview?: boolean; focus?: boolean } = {}) {
  await editorService().openInput(diffInput(data), { preview: opts.preview, focus: opts.focus ?? true });
}

/** Default local-changes diff for a working file: HEAD (or empty) vs the working copy. */
export function workingDiffData(path: string, line?: number): DiffData {
  const st = statusOf(path);
  const kind = st ? effectiveKind(st) : null;
  const left: DiffSide =
    kind === "untracked" || kind === "added"
      ? { type: "text", text: "", label: "(does not exist)" }
      : st?.renamedFrom
        ? { type: "rev", rev: "HEAD", path: renamedFromPath(st) ?? undefined, label: `HEAD (${st.renamedFrom})` }
        : { type: "rev", rev: "HEAD" };
  const right: DiffSide = kind === "deleted" ? { type: "text", text: "", label: "(deleted)" } : { type: "worktree" };
  return { path, left, right, line };
}

/** A path of the selected repository's log (repository-relative) made absolute. */
function joinRoot(rel: string, root = currentRepoRoot()): string {
  return root ? `${root}/${rel}` : rel;
}

/** Diff of one file changed by `commit` (first parent ↔ commit). */
export function commitFileDiffData(
  commit: { id: string; shortId: string; parents: string[]; repo?: string | null },
  file: ChangedFile,
): DiffData {
  const path = joinRoot(file.path, commit.repo ?? currentRepoRoot());
  const parent = commit.parents[0];
  const left: DiffSide =
    !parent || file.kind === "added"
      ? { type: "text", text: "", label: "(does not exist)" }
      : {
          type: "rev",
          rev: parent,
          path: file.oldPath ? joinRoot(file.oldPath, commit.repo ?? currentRepoRoot()) : undefined,
          label: parent.slice(0, 8),
        };
  const right: DiffSide =
    file.kind === "deleted"
      ? { type: "text", text: "", label: "(deleted)" }
      : { type: "rev", rev: commit.id, label: commit.shortId };
  return { path, left, right };
}

/** Diff of one file of several commits' combined changes (`before` ↔ `after`). */
export function revisionChangeDiffData(change: RevisionChange, root = currentRepoRoot()): DiffData {
  const path = joinRoot(change.path, root);
  const { before, after } = change;
  const left: DiffSide = before
    ? {
        type: "rev",
        rev: before,
        path: change.oldPath ? joinRoot(change.oldPath, root) : undefined,
        label: before.slice(0, 8),
      }
    : { type: "text", text: "", label: "(does not exist)" };
  const right: DiffSide = after
    ? { type: "rev", rev: after, label: after.slice(0, 8) }
    : { type: "text", text: "", label: "(deleted)" };
  return { path, left, right };
}

export async function loadSide(path: string, side: DiffSide): Promise<string> {
  switch (side.type) {
    case "rev":
      return (await call(commands.vcsFileAt(side.path ?? path, side.rev))) ?? "";
    case "worktree":
      return (await readWorkingText(path)) ?? "";
    case "file":
      return (await readWorkingText(side.path)) ?? "";
    case "text":
      return side.text;
    case "history":
      return call(commands.historyContent(side.id));
  }
}

export const isWorktree = (s: DiffSide) => s.type === "worktree";
/** Path of a side backed by a file on disk (editable in the diff), else null. */
export const sideFile = (s: DiffSide, path: string): string | null =>
  s.type === "worktree" ? path : s.type === "file" ? s.path : null;
export const isIndex = (s: DiffSide) => s.type === "rev" && (s.rev === ":0" || s.rev === ":");
