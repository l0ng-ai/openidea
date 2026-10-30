/** Commit tool window model: change groups, directory tree, inclusion (pure). */
import type { ChangelistState, FileStatus } from "@/bindings";
import { baseName, dirName, effectiveKind, relTo, repoLabel, rootOf, stripSlash, type EffectiveKind } from "./model";
import { tx } from "@/platform/i18n";

export type GroupId = "conflicts" | "changes" | "unversioned";

export const GROUP_LABEL: Record<GroupId, string> = {
  conflicts: "Merge Conflicts",
  changes: "Changes",
  unversioned: "Unversioned Files",
};

/**
 * Inclusion of a file in the next commit:
 * `all` – stage everything before committing; `none` – keep out (unstage);
 * `staged` – commit only what is already staged (partially staged files);
 * `hunks` – commit only the changed blocks not excluded in the diff (IDEA's partial
 * commit; see `excludedHunks`), through a temporary index.
 */
export type CheckState = "all" | "none" | "staged" | "hunks";

export interface ChangeNode {
  key: string;
  type: "group" | "dir" | "file";
  label: string;
  group: GroupId;
  children?: ChangeNode[];
  /** Files below this node (the file itself for file nodes). */
  files: FileStatus[];
  kind?: EffectiveKind;
  /** Absolute path (files and directories). */
  path?: string;
  /** Detail text: the relative directory (flat mode) or the old name. */
  detail?: string;
  /** Change list id (change list groups and their descendants). */
  changelist?: string;
  /** The active change list's group. */
  active?: boolean;
}

export function groupOf(fs: FileStatus): GroupId | null {
  const kind = effectiveKind(fs);
  if (!kind || kind === "ignored") return null;
  if (kind === "conflicted") return "conflicts";
  if (kind === "untracked") return "unversioned";
  return "changes";
}

export function isPartiallyStaged(fs: FileStatus): boolean {
  return (
    !!fs.staged &&
    !!fs.unstaged &&
    fs.unstaged !== "untracked" &&
    fs.unstaged !== "conflicted" &&
    fs.staged !== "conflicted"
  );
}

export function initialCheck(fs: FileStatus): CheckState {
  const g = groupOf(fs);
  // Unversioned files and unresolved conflicts are opt-in, as in IDEA.
  if (g !== "changes") return "none";
  return isPartiallyStaged(fs) ? "staged" : "all";
}

export function checkOf(fs: FileStatus, checks: ReadonlyMap<string, CheckState>): CheckState {
  return checks.get(fs.path) ?? initialCheck(fs);
}

/** Aggregate checkbox state for a set of files. */
export function aggregateCheck(files: readonly FileStatus[], checks: ReadonlyMap<string, CheckState>) {
  let on = 0;
  let partial = false;
  for (const f of files) {
    const c = checkOf(f, checks);
    if (c !== "none") on++;
    if (c === "staged" || c === "hunks") partial = true;
  }
  return {
    checked: on > 0 && on === files.length && !partial,
    indeterminate: (on > 0 && on < files.length) || partial,
    on,
  };
}

const KIND_ORDER: GroupId[] = ["conflicts", "changes", "unversioned"];

function fileNode(fs: FileStatus, root: string, group: GroupId, flat: boolean, scope: string = group): ChangeNode {
  const path = stripSlash(fs.path);
  const rel = relTo(root, path);
  const kind = effectiveKind(fs) ?? "modified";
  const dir = dirName(rel);
  return {
    key: `${scope}:${path}`,
    type: "file",
    label: baseName(path),
    group,
    files: [fs],
    kind,
    path,
    detail: !fs.renamedFrom
      ? flat
        ? dir
        : undefined
      : flat && dir
        ? tx`${dir} · from ${fs.renamedFrom}`
        : tx`from ${fs.renamedFrom}`,
  };
}

interface Trie {
  dirs: Map<string, Trie>;
  files: FileStatus[];
}

function dirNodes(trie: Trie, prefix: string, root: string, group: GroupId, scope: string = group): ChangeNode[] {
  const out: ChangeNode[] = [];
  const dirs = [...trie.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, sub] of dirs) {
    // Compact chains of directories that only contain one directory ("src/main/kotlin").
    let label = name;
    let node = sub;
    let rel = prefix ? `${prefix}/${name}` : name;
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [n, s] = [...node.dirs.entries()][0]!;
      label += `/${n}`;
      rel += `/${n}`;
      node = s;
    }
    const children = dirNodes(node, rel, root, group, scope);
    const files = collect(node);
    out.push({
      key: `${scope}:dir:${rel}`,
      type: "dir",
      label,
      group,
      children,
      files,
      path: `${root}/${rel}`,
    });
  }
  const files = [...trie.files].sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
  for (const f of files) out.push(fileNode(f, root, group, false, scope));
  return out;
}

function collect(t: Trie): FileStatus[] {
  const out = [...t.files];
  for (const s of t.dirs.values()) out.push(...collect(s));
  return out;
}

function childNodes(files: readonly FileStatus[], root: string, group: GroupId, groupByDir: boolean, scope: string) {
  if (groupByDir) {
    const trie: Trie = { dirs: new Map(), files: [] };
    for (const f of files) {
      const rel = relTo(root, stripSlash(f.path));
      const parts = rel.split("/");
      parts.pop();
      let t = trie;
      for (const p of parts) {
        let next = t.dirs.get(p);
        if (!next) t.dirs.set(p, (next = { dirs: new Map(), files: [] }));
        t = next;
      }
      t.files.push(f);
    }
    return dirNodes(trie, "", root, group, scope);
  }
  return [...files]
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)) || a.path.localeCompare(b.path))
    .map((f) => fileNode(f, root, group, true, scope));
}

/** With several repositories, a node per repository (IDEA's "Group by Repository") above the files. */
function repoNodes(
  files: readonly FileStatus[],
  root: string,
  group: GroupId,
  groupByDir: boolean,
  scope: string,
  repos: readonly string[],
): ChangeNode[] {
  if (repos.length < 2) return childNodes(files, root, group, groupByDir, scope);
  const byRepo = new Map<string, FileStatus[]>();
  for (const f of files) {
    const repo = rootOf(f.path, repos) ?? root;
    let list = byRepo.get(repo);
    if (!list) byRepo.set(repo, (list = []));
    list.push(f);
  }
  const order = (r: string) => (repos.includes(r) ? repos.indexOf(r) : repos.length);
  return [...byRepo]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([repo, own]) => ({
      key: `${scope}:repo:${repo}`,
      type: "dir" as const,
      label: repoLabel(repo, root),
      group,
      children: childNodes(own, repo, group, groupByDir, `${scope}@${repo}`),
      files: own,
      path: repo,
    }));
}

function tagList(nodes: ChangeNode[], id: string): ChangeNode[] {
  for (const n of nodes) {
    n.changelist = id;
    if (n.children) tagList(n.children, id);
  }
  return nodes;
}

/**
 * Group roots (Merge Conflicts / Changes / Unversioned Files) with flat or directory
 * children. With change lists, "Changes" is split into one group per list
 * (`ChangelistState.files` keys are project-relative paths). With several
 * repositories (`repos`), each group's files are grouped by repository first.
 */
export function buildChangeTree(
  status: readonly FileStatus[],
  root: string,
  groupByDir: boolean,
  lists?: ChangelistState,
  repos: readonly string[] = [],
): ChangeNode[] {
  const byGroup = new Map<GroupId, FileStatus[]>();
  for (const fs of status) {
    const g = groupOf(fs);
    if (!g) continue;
    let list = byGroup.get(g);
    if (!list) byGroup.set(g, (list = []));
    list.push(fs);
  }
  const roots: ChangeNode[] = [];
  for (const g of KIND_ORDER) {
    const files = byGroup.get(g) ?? [];
    if (g === "changes" && lists) {
      const byList = new Map<string, FileStatus[]>(lists.lists.map((l) => [l.id, []]));
      for (const f of files) {
        const id = lists.files?.[relTo(root, stripSlash(f.path))];
        byList.get(id && byList.has(id) ? id : lists.active)?.push(f);
      }
      for (const l of lists.lists) {
        const own = byList.get(l.id) ?? [];
        // Empty lists are shown once the user has more than the default one.
        if (!own.length && lists.lists.length < 2) continue;
        const scope = `changes@${l.id}`;
        roots.push({
          key: `group:cl:${l.id}`,
          type: "group",
          label: l.name,
          group: g,
          children: tagList(repoNodes(own, root, g, groupByDir, scope, repos), l.id),
          files: own,
          changelist: l.id,
          active: l.id === lists.active,
          detail: l.comment ? l.comment.split("\n")[0] : undefined,
        });
      }
      continue;
    }
    if (!files.length) continue;
    const children = repoNodes(files, root, g, groupByDir, g, repos);
    roots.push({ key: `group:${g}`, type: "group", label: GROUP_LABEL[g], group: g, children, files });
  }
  return roots;
}

export interface CommitPlan {
  stage: string[];
  unstage: string[];
  /** Files that end up in the commit. */
  included: FileStatus[];
  /** Absolute paths of included files committed with only some of their hunks. */
  partial: string[];
}

/**
 * Repositories to commit: those holding `included` files (the selected one last, so its
 * commit id is returned), else just the selected one (amend, concluding a merge).
 */
export function commitRepos(
  included: readonly FileStatus[],
  roots: readonly string[],
  selected: string | null,
): Array<string | null> {
  const repos = [...new Set(included.map((f) => rootOf(f.path, roots)).filter((r): r is string => !!r))];
  if (!repos.length) return [selected];
  return selected && repos.includes(selected) ? [...repos.filter((r) => r !== selected), selected] : repos;
}

/** Absolute path of the source of a staged rename (`renamedFrom` is repository-relative). */
export function renamedFromPath(fs: FileStatus): string | null {
  if (!fs.renamedFrom) return null;
  const path = stripSlash(fs.path);
  const root = path.endsWith(fs.relPath) ? path.slice(0, path.length - fs.relPath.length) : null;
  return root === null ? null : `${root}${fs.renamedFrom}`;
}

/** What to stage / unstage so the index holds exactly the included changes. */
export function planCommit(status: readonly FileStatus[], checks: ReadonlyMap<string, CheckState>): CommitPlan {
  const plan: CommitPlan = { stage: [], unstage: [], included: [], partial: [] };
  for (const fs of status) {
    if (!groupOf(fs)) continue;
    const c = checkOf(fs, checks);
    const path = stripSlash(fs.path);
    if (c === "none") {
      if (fs.staged && fs.staged !== "conflicted") {
        plan.unstage.push(path);
        // A staged rename is a deletion + addition: leaving the deletion staged would commit it.
        const from = renamedFromPath(fs);
        if (from) plan.unstage.push(from);
      }
      continue;
    }
    if (c === "all" && fs.unstaged) plan.stage.push(path);
    if (c === "staged" && !fs.staged) continue;
    if (c === "hunks") plan.partial.push(path);
    plan.included.push(fs);
  }
  return plan;
}

/**
 * Toggling the checkbox of one changed block (`key`, one of `all`) in the diff: the file's
 * new inclusion and excluded blocks. All blocks back in → `all`; none left → `none`.
 */
export function toggledHunk(
  current: CheckState,
  excluded: ReadonlySet<string> | undefined,
  all: readonly string[],
  key: string,
): { check: CheckState; excluded: Set<string> } {
  const out = new Set(
    current === "none" ? all : current === "hunks" ? [...(excluded ?? [])].filter((k) => all.includes(k)) : [],
  );
  if (out.has(key)) out.delete(key);
  else out.add(key);
  if (!out.size) return { check: "all", excluded: out };
  if (all.every((k) => out.has(k))) return { check: "none", excluded: new Set() };
  return { check: "hunks", excluded: out };
}

/** Whether a changed block is included, given its file's inclusion. */
export function hunkIncluded(check: CheckState, excluded: ReadonlySet<string> | undefined, key: string): boolean {
  if (check === "none") return false;
  if (check === "hunks") return !excluded?.has(key);
  return true;
}

/** Toggling a checkbox: anything included → none; none → all. */
export function toggledCheck(current: CheckState): CheckState {
  return current === "none" ? "all" : "none";
}

/**
 * Paths of the selection to add to an ignore file: unversioned files, and a directory
 * whose files are all unversioned (one rule for it instead of a rule per file).
 */
export function ignoreTargets(nodes: readonly ChangeNode[], repos: readonly string[]): string[] {
  const roots = new Set(repos.map(stripSlash));
  const out = new Set<string>();
  const add = (n: ChangeNode) => {
    const untracked = n.files.filter((f) => f.unstaged === "untracked");
    if (!untracked.length) return;
    // A repository node's path is the root itself, which cannot be ignored.
    if (n.type === "dir" && n.path && n.files.length === untracked.length && !roots.has(stripSlash(n.path))) {
      out.add(stripSlash(n.path));
      return;
    }
    if (n.children?.length) n.children.forEach(add);
    else for (const f of untracked) out.add(stripSlash(f.path));
  };
  nodes.forEach(add);
  return [...out];
}

/** File paths (absolute) under the given tree nodes. */
export function filesOf(nodes: readonly ChangeNode[]): FileStatus[] {
  const seen = new Set<string>();
  const out: FileStatus[] = [];
  for (const n of nodes)
    for (const f of n.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  return out;
}
