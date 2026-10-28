/** Branches popup model for a project with several repositories (pure). */
import type { Branch } from "@/bindings";
import { tx } from "@/platform/i18n";
import { fuzzyMatch } from "@/ui/match";
import { rootOf } from "./model";
import { isFavoriteBranch, MAX_RECENT, sortLocal, sortRemote, type PopupAction } from "./branches";

export interface RepoEntry {
  root: string;
  name: string;
  /** Current branch; `null` when HEAD is detached. */
  head: string | null;
  headCommit: string | null;
}

/** Number of `--project-color-N` tokens repositories are coloured with. */
export const REPO_COLORS = 9;

/** Colour slot (1-based) of the repository at `index`: distinct for up to `REPO_COLORS` repositories. */
export function repoColorIndex(index: number): number {
  return (index % REPO_COLORS) + 1;
}

/** Display name of a repository's HEAD: its branch, else the short commit. */
export function repoHeadLabel(r: Pick<RepoEntry, "head" | "headCommit">): string {
  if (r.head) return r.head;
  return r.headCommit ? r.headCommit.slice(0, 8) : tx("No commits");
}

/**
 * The current repository, shown by the branch widget and the lower part of the Branches
 * popup: the one holding the active editor's file, else the selected one, else the first.
 */
export function currentRepoFor(
  activePath: string | null,
  roots: readonly string[],
  selected: string | null,
): string | null {
  const ofFile = activePath ? rootOf(activePath, roots) : null;
  return ofFile ?? (selected && roots.includes(selected) ? selected : null) ?? roots[0] ?? null;
}

/**
 * Whether the branch widget names the repository besides the branch: only with several
 * repositories that are not all on the same branch.
 */
export function widgetShowsRepo(repos: readonly Pick<RepoEntry, "head">[]): boolean {
  if (repos.length < 2) return false;
  const first = repos[0]!.head;
  return !first || repos.some((r) => r.head !== first);
}

export interface CommonBranch {
  name: string;
  remote: boolean;
  /** Checked out in every repository. */
  current: boolean;
  favorite: boolean;
}

/** Branches present in every repository (by name), local and remote, sorted like the single-repository lists. */
export function commonBranches(
  branchesByRepo: readonly (readonly Branch[])[],
  favorites: readonly string[] | null = null,
): { local: CommonBranch[]; remote: CommonBranch[] } {
  if (!branchesByRepo.length) return { local: [], remote: [] };
  const pick = (sorted: (list: readonly Branch[]) => Branch[]): CommonBranch[] => {
    const [first, ...rest] = branchesByRepo;
    const others = rest.map((list) => new Map(list.map((b) => [`${b.remote}:${b.name}`, b])));
    return sorted(first!).flatMap((b) => {
      const all = others.map((m) => m.get(`${b.remote}:${b.name}`));
      if (all.some((x) => !x)) return [];
      return [
        {
          name: b.name,
          remote: b.remote,
          current: b.current && all.every((x) => x!.current),
          favorite: isFavoriteBranch(b, favorites),
        },
      ];
    });
  };
  const byRank = (a: CommonBranch, b: CommonBranch) =>
    Number(b.current) - Number(a.current) || Number(b.favorite) - Number(a.favorite);
  return {
    local: pick((l) => sortLocal(l, favorites)).sort(byRank),
    remote: pick((l) => sortRemote(l, favorites)).sort(byRank),
  };
}

export type BranchGroupKind = "recent" | "local" | "remote";

export type RepoRow =
  /** Section header; an empty label draws a separator. */
  | { type: "section"; key: string; label: string }
  | { type: "action"; key: string; action: PopupAction; matches: number[] | null }
  | { type: "repo"; key: string; repo: RepoEntry; color: number; matches: number[] | null }
  /** Collapsible group (common branches, or one of the current repository's lists) or remote folder. */
  | { type: "group"; key: string; label: string; expanded: boolean; depth: number }
  | {
      type: "common";
      key: string;
      branch: CommonBranch;
      /** Shown name: remote branches without their remote (it is the folder). */
      label: string;
      depth: number;
      matches: number[] | null;
    }
  /** A branch of one repository. */
  | {
      type: "branch";
      key: string;
      repo: RepoEntry;
      branch: Branch;
      group: BranchGroupKind;
      depth: number;
      matches: number[] | null;
      favorite: boolean;
    }
  | { type: "tag"; key: string; repo: RepoEntry; tag: string; depth: number; matches: number[] | null };

/**
 * Initially expanded groups: the common local branches, and the current repository's
 * local branches (switching a repository's branch stays one click away).
 */
export const DEFAULT_EXPANDED: readonly string[] = ["common:local", "repo:local"];

export interface MultiRepoInput {
  repos: readonly RepoEntry[];
  /** Root → its branches (missing while loading). */
  branches: Readonly<Record<string, readonly Branch[]>>;
  query: string;
  actions: readonly PopupAction[];
  /** Expanded group / folder keys (`common:local`, `repo:remote`, `common:folder:origin`…). */
  expanded: ReadonlySet<string>;
  favorites?: readonly string[] | null;
  /** The current repository (of the active file), whose lists are shown when the repositories' branches differ. */
  current?: string | null;
  /** Recently checked-out branches (newest first). */
  recent?: readonly string[];
  /** Tags of the current repository. */
  tags?: readonly string[];
}

/**
 * Rows of the Branches popup with several repositories: actions; the repositories,
 * each with its current branch and opening its own branches; then, when they are all
 * on the same branch, the branches common to all of them (acting on all of them),
 * otherwise the current repository's recent, local and remote branches and tags, in
 * collapsible groups. A query filters actions, repositories (by name) and branches,
 * expands every group, and adds the other repositories' matching branches.
 */
export function buildMultiRepoRows({
  repos,
  branches,
  query,
  actions,
  expanded,
  favorites = null,
  current = null,
  recent = [],
  tags = [],
}: MultiRepoInput): RepoRow[] {
  const q = query.trim();
  const match = (text: string): number[] | null | false => (q ? (fuzzyMatch(text, q) ?? false) : null);
  const open = (key: string) => !!q || expanded.has(key);
  const blocks: RepoRow[][] = [];

  const actionRows: RepoRow[] = [];
  for (const a of actions) {
    const m = match(tx(a.label));
    if (m !== false) actionRows.push({ type: "action", key: `action:${a.id}`, action: a, matches: m });
  }
  blocks.push(actionRows);

  const repoRows: RepoRow[] = [];
  repos.forEach((repo, i) => {
    const m = match(repo.name);
    if (m !== false)
      repoRows.push({ type: "repo", key: `repo:${repo.root}`, repo, color: repoColorIndex(i), matches: m });
  });
  blocks.push(repoRows);

  /** A group row followed (when expanded) by its children; nothing when it has none. */
  const group = (out: RepoRow[], key: string, label: string, depth: number, children: RepoRow[]) => {
    if (!children.length) return;
    const expandedNow = open(key);
    out.push({ type: "group", key, label, expanded: expandedNow, depth });
    if (expandedNow) out.push(...children);
  };
  const branchRows = (repo: RepoEntry, list: readonly Branch[], kind: BranchGroupKind, depth: number) =>
    list.flatMap((b): RepoRow[] => {
      const m = match(b.name);
      if (m === false) return [];
      const key = `branch:${repo.root}:${kind}:${b.name}`;
      return [
        {
          type: "branch",
          key,
          repo,
          branch: b,
          group: kind,
          depth,
          matches: m,
          favorite: isFavoriteBranch(b, favorites),
        },
      ];
    });

  const shared = !widgetShowsRepo(repos);
  const groups: RepoRow[] = [];
  let shown = new Set<string>();
  const currentRepo = repos.find((r) => r.root === current) ?? repos[0];
  if (shared) {
    const loaded = repos.every((r) => branches[r.root]);
    const common = loaded
      ? commonBranches(
          repos.map((r) => branches[r.root]!),
          favorites,
        )
      : { local: [], remote: [] };
    shown = new Set([...common.local, ...common.remote].map((b) => `${b.remote}:${b.name}`));
    const local = common.local.flatMap((b): RepoRow[] => {
      const m = match(b.name);
      return m === false
        ? []
        : [{ type: "common", key: `common:${b.name}`, branch: b, label: b.name, depth: 1, matches: m }];
    });
    group(groups, "common:local", tx("Common Local Branches"), 0, local);
    const byRemote = new Map<string, CommonBranch[]>();
    for (const b of common.remote) {
      const remote = b.name.slice(0, Math.max(0, b.name.indexOf("/")));
      byRemote.set(remote, [...(byRemote.get(remote) ?? []), b]);
    }
    const remote: RepoRow[] = [];
    for (const [name, items] of byRemote) {
      const leaves = items.flatMap((b): RepoRow[] => {
        const m = match(b.name);
        if (m === false) return [];
        // Highlights are of the full name: shift them onto the shown part.
        const part = m && m.map((i) => i - name.length - 1).filter((i) => i >= 0);
        const label = b.name.slice(name.length + 1);
        return [{ type: "common", key: `common:${b.name}`, branch: b, label, depth: 2, matches: part }];
      });
      group(remote, `common:folder:${name}`, name, 1, leaves);
    }
    group(groups, "common:remote", tx("Common Remote Branches"), 0, remote);
  } else if (currentRepo) {
    const list = branches[currentRepo.root] ?? [];
    const local = sortLocal(list, favorites);
    const byName = new Map(local.map((b) => [b.name, b]));
    const recentList = q
      ? []
      : recent
          .map((n) => byName.get(n))
          .filter((b): b is Branch => !!b && !b.current)
          .slice(0, MAX_RECENT);
    const name = currentRepo.name;
    group(groups, "repo:recent", tx`Recent Branches in ${name}`, 0, branchRows(currentRepo, recentList, "recent", 1));
    group(groups, "repo:local", tx`Local Branches in ${name}`, 0, branchRows(currentRepo, local, "local", 1));
    group(
      groups,
      "repo:remote",
      tx`Remote Branches in ${name}`,
      0,
      branchRows(currentRepo, sortRemote(list, favorites), "remote", 1),
    );
    const tagRows = [...tags]
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .flatMap((t): RepoRow[] => {
        const m = match(t);
        return m === false
          ? []
          : [{ type: "tag", key: `tag:${currentRepo.root}:${t}`, repo: currentRepo, tag: t, depth: 1, matches: m }];
      });
    group(groups, "repo:tags", tx`Tags in ${name}`, 0, tagRows);
  }
  blocks.push(groups);

  if (q) {
    for (const repo of repos) {
      if (!shared && repo === currentRepo) continue;
      const list = branches[repo.root] ?? [];
      const own = (l: Branch[]) => l.filter((b) => !shown.has(`${b.remote}:${b.name}`));
      const rows = [
        ...branchRows(repo, own(sortLocal(list, favorites)), "local", 0),
        ...branchRows(repo, own(sortRemote(list, favorites)), "remote", 0),
      ];
      if (rows.length) blocks.push([{ type: "section", key: `section:${repo.root}`, label: repo.name }, ...rows]);
    }
  }

  const rows: RepoRow[] = [];
  for (const block of blocks) {
    if (!block.length) continue;
    if (rows.length && block[0]!.type !== "section")
      rows.push({ type: "section", key: `separator:${rows.length}`, label: "" });
    rows.push(...block);
  }
  return rows;
}

/** Toggles a group / folder key. */
export function toggleExpanded(expanded: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(key)) next.add(key);
  return next;
}
