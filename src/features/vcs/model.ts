/** Pure VCS model helpers: effective file status, colours, decorations. */
import type { ChangeKind, FileStatus } from "@/bindings";
import type { FileDecoration } from "@/workbench/contributions";
import { formatDay, formatTimestamp } from "@/platform/dateFormat";
import { tx } from "@/platform/i18n";

/** What a file looks like in IDEA's change lists (one kind per file). */
export type EffectiveKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "ignored" | "conflicted";

export function effectiveKind(fs: Pick<FileStatus, "staged" | "unstaged">): EffectiveKind | null {
  const { staged, unstaged } = fs;
  if (staged === "conflicted" || unstaged === "conflicted") return "conflicted";
  if (unstaged === "untracked") return staged ? kindOf(staged) : "untracked";
  if (unstaged === "ignored") return "ignored";
  // A file added to the index stays "added" (green) while it has further edits.
  if (staged === "added") return unstaged === "deleted" ? null : "added";
  if (unstaged === "deleted" || staged === "deleted") return "deleted";
  if (staged === "renamed") return "renamed";
  if (staged || unstaged) return "modified";
  return null;
}

function kindOf(k: ChangeKind): EffectiveKind {
  return k === "untracked" ? "untracked" : k;
}

export const KIND_COLOR: Record<EffectiveKind, string> = {
  modified: "var(--vcs-modified)",
  renamed: "var(--vcs-modified)",
  added: "var(--vcs-added)",
  deleted: "var(--vcs-deleted)",
  untracked: "var(--vcs-untracked)",
  ignored: "var(--vcs-ignored)",
  conflicted: "var(--vcs-conflict)",
};

export const KIND_LABEL: Record<EffectiveKind, string> = {
  modified: "Modified",
  renamed: "Renamed",
  added: "Added",
  deleted: "Deleted",
  untracked: "Unversioned",
  ignored: "Ignored",
  conflicted: "Merge conflict",
};

/** Folder colour precedence: earlier kinds win when a folder holds several. */
const FOLDER_PRECEDENCE: EffectiveKind[] = ["conflicted", "modified", "renamed", "added", "deleted", "untracked"];

export function stripSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * File decorations for the project tree / tabs. Keys are absolute paths.
 * Folders inherit the colour of their most significant descendant (conflict,
 * then modified…), as IDEA's "highlight directories that contain modified files".
 */
export function statusDecorations(status: readonly FileStatus[], propagate = true): Map<string, FileDecoration> {
  const entries: Array<[string, FileDecoration, number]> = [];
  for (const fs of status) {
    const kind = effectiveKind(fs);
    if (!kind) continue;
    const deco: FileDecoration = {
      color: KIND_COLOR[kind],
      tooltip: fs.renamedFrom ? tx`${KIND_LABEL[kind]} (from ${fs.renamedFrom})` : KIND_LABEL[kind],
    };
    if (kind === "ignored") deco.faded = true;
    // Settings › Version Control › Show directories with changed descendants.
    else if (propagate) deco.propagate = true;
    // Git reports untracked / ignored folders as one `dir/` entry: decorate their whole content.
    if (fs.path.endsWith("/")) deco.subtree = true;
    const rank = FOLDER_PRECEDENCE.indexOf(kind);
    entries.push([stripSlash(fs.path), deco, rank < 0 ? FOLDER_PRECEDENCE.length : rank]);
  }
  // `setFileDecorations` gives folders the colour of the first propagating entry.
  entries.sort((a, b) => a[2] - b[2]);
  return new Map(entries.map(([p, d]) => [p, d]));
}

export function relTo(root: string, path: string): string {
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/**
 * The innermost of `roots` (repository roots) containing `path`. A nested repository's root
 * is an entry of the enclosing one (submodule, untracked folder), so it belongs there; to
 * itself only when no root encloses it (as the backend routes it).
 */
export function rootOf(path: string, roots: readonly string[]): string | null {
  const p = stripSlash(path);
  let best: string | null = null;
  for (const r of roots) if (p.startsWith(`${r}/`) && (!best || r.length > best.length)) best = r;
  return best ?? (roots.includes(p) ? p : null);
}

/** Repository name for display: its folder relative to the project, else its folder name. */
export function repoLabel(root: string, projectRoot: string | null): string {
  if (projectRoot && root.startsWith(`${projectRoot}/`)) return root.slice(projectRoot.length + 1);
  return baseName(root) || root;
}

export function baseName(path: string): string {
  const p = stripSlash(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function dirName(path: string): string {
  const p = stripSlash(path);
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** List timestamp per Settings › System Settings › Date Formats. */
export function formatTime(ms: number | null | undefined, now = Date.now()): string {
  return ms ? formatTimestamp(ms, now) : "";
}

export function formatDate(ms: number | null | undefined): string {
  return ms ? formatDay(new Date(ms), undefined, true) : "";
}

/** Parses a git progress line ("Receiving objects:  45% (9/20)") into a fraction. */
export function progressFraction(line: string): number | null {
  const m = /(\d{1,3})%/.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n / 100 : null;
}

/**
 * Splits a stash subject (`On main: msg`, `WIP on main: 1a2b3c subject`) into
 * the branch and the user-facing text, as IDEA's stash list shows them.
 */
export function stashLabel(message: string): { branch: string | null; text: string } {
  const m = /^(?:WIP on|On) ([^:]+): ?(.*)$/s.exec(message);
  if (!m) return { branch: null, text: message };
  return { branch: m[1]!, text: m[2]!.trim() || message };
}

/**
 * Web page of a git remote URL (`git@github.com:o/r.git`, `ssh://git@host:22/o/r`,
 * `https://user@host/o/r.git`), or null for local paths.
 */
export function remoteWebUrl(url: string): string | null {
  const u = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  let host: string;
  let path: string;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(u);
  const full = /^(?:ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u);
  if (full) [, host, path] = full as unknown as [string, string, string];
  else if (scp) [, host, path] = scp as unknown as [string, string, string];
  else return null;
  return `https://${host}/${path.replace(/^\/+/, "")}`;
}

/** Commit page on the remote's web UI (Bitbucket uses `/commits/`). */
export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  const base = remoteWebUrl(remoteUrl);
  if (!base) return null;
  return `${base}/${/bitbucket\.org\//.test(base) ? "commits" : "commit"}/${sha}`;
}

/** "N file(s)", worded for the locale. */
export function fileCount(n: number): string {
  return n === 1 ? tx`${n} file` : tx`${n} files`;
}
