/** Chooser for revision actions, including a selection spanning multiple repositories. */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Dialog, HighlightedText, Icon, List, SearchField, fuzzyMatch, listNavigate } from "@/ui";
import { sortLocal, sortRemote } from "./branches";
import { openDialog } from "./dialogs";
import { call, commands } from "@/platform/ipc";
import type { Branch } from "@/bindings";
import { currentRepo, repoName } from "./store";
import { tx } from "@/platform/i18n";
import styles from "./common.module.css";

export interface RevisionChoice {
  rev: string;
  /** null applies an entered revision to every repository in the selection. */
  repositories: string[] | null;
}

interface Item extends RevisionChoice {
  detail: string;
  matches: number[] | null;
  section?: boolean;
}

export interface RepositoryRevisions {
  root: string | null;
  branches: Branch[];
  tags: string[];
}

export interface ChooseRevisionOptions {
  tags?: boolean;
  placeholder?: string;
  repositories?: string[];
}

/** Shared branches first, followed by each repository's revisions. */
export function revisionItems(repos: RepositoryRevisions[], query: string): Item[] {
  const all: Item[] = [{ rev: "HEAD", detail: tx("Last commit"), repositories: null, matches: null }];
  const multi = repos.length > 1;
  if (multi) {
    const shared = new Map<string, string[]>();
    for (const repo of repos) {
      for (const name of new Set(repo.branches.map((b) => b.name))) {
        const roots = shared.get(name) ?? [];
        if (repo.root) roots.push(repo.root);
        shared.set(name, roots);
      }
    }
    for (const [rev, repositories] of shared) {
      if (repositories.length > 1)
        all.push({ rev, detail: tx`in ${repositories.length} repositories`, repositories, matches: null });
    }
  }
  for (const repo of repos) {
    if (multi)
      all.push({
        rev: repoName(repo.root ?? ""),
        detail: repo.root ?? "",
        repositories: [],
        matches: null,
        section: true,
      });
    const repositories = repo.root ? [repo.root] : null;
    all.push(
      ...sortLocal(repo.branches).map((b) => ({
        rev: b.name,
        detail: tx(b.current ? "current branch" : "local"),
        repositories,
        matches: null,
      })),
      ...sortRemote(repo.branches).map((b) => ({ rev: b.name, detail: tx("remote"), repositories, matches: null })),
      ...repo.tags.map((rev) => ({ rev, detail: tx("tag"), repositories, matches: null })),
    );
  }
  const q = query.trim();
  if (!q) return all;
  const filtered = all
    .flatMap((i) => {
      if (i.section) return [i];
      const matches = fuzzyMatch(i.rev, q);
      return matches ? [{ ...i, matches }] : [];
    })
    .filter((i, idx, list) => !i.section || (!!list[idx + 1] && !list[idx + 1]!.section));
  // Always allow applying a typed revision across the full selection, even when one repo offers it.
  if (!filtered.some((i) => !i.section && i.rev === q && i.repositories === null))
    filtered.push({ rev: q, detail: tx("revision"), repositories: null, matches: null });
  return filtered;
}

export async function chooseRevision(title: string, options: ChooseRevisionOptions = {}): Promise<string | null> {
  return (await chooseRepositoryRevision(title, options))?.rev ?? null;
}

export function chooseRepositoryRevision(
  title: string,
  options: ChooseRevisionOptions,
): Promise<RevisionChoice | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <Chooser
        title={title}
        options={options}
        onDone={(r) => {
          close();
          resolve(r);
        }}
      />
    ));
  });
}

function Chooser({
  title,
  options,
  onDone,
}: {
  title: string;
  options: ChooseRevisionOptions;
  onDone: (rev: RevisionChoice | null) => void;
}) {
  const [roots] = useState(() => options.repositories ?? [currentRepo()]);
  const [repos, setRepos] = useState<RepositoryRevisions[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      roots.map(async (root) => {
        const [branches, tags] = await Promise.allSettled([
          call(commands.vcsBranches(root)),
          options.tags ? call(commands.vcsTags(root)) : Promise.resolve<string[]>([]),
        ]);
        for (const outcome of [branches, tags])
          if (outcome.status === "rejected" && alive) setError(`${root ?? ""}: ${String(outcome.reason)}`);
        return {
          root,
          branches: branches.status === "fulfilled" ? branches.value : [],
          tags: tags.status === "fulfilled" ? tags.value : [],
        };
      }),
    )
      .then((r) => alive && setRepos(r))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [options.tags, roots]);
  const items = useMemo(() => revisionItems(repos, query), [repos, query]);
  const idx = Math.min(active, items.length - 1);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items[idx];
      if (it && !it.section) onDone(it);
      return;
    }
    const n = listNavigate(e.key, { items, active: idx, isSection: (i) => !!i.section, wrap: true });
    if (n !== null) {
      e.preventDefault();
      setActive(n);
    }
  };
  return (
    <Dialog open title={title} onClose={() => onDone(null)} width={460} position="top">
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border-popup)" }}>
        <SearchField
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={options.placeholder ?? "Branch, tag or commit hash"}
          aria-label="Revision"
          variant="bare"
        />
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div style={{ height: 280, display: "flex", flexDirection: "column", padding: "4px 0" }}>
        <List
          items={items}
          getKey={(i) => `${i.repositories?.join(":")}:${i.detail}:${i.rev}`}
          activeIndex={idx}
          onActiveChange={setActive}
          onActivate={(i) => onDone(i)}
          isSection={(i) => !!i.section}
          renderSection={(i) => <span title={i.detail}>{i.rev}</span>}
          focusable={false}
          hoverSelects
          rowHeight={24}
          aria-label="Revisions"
          className={styles.grow}
          renderItem={(i) => (
            <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
              <Icon
                name={i.detail === tx("revision") ? "commit" : i.detail === tx("tag") ? "tag" : "branch"}
                size={14}
              />
              <HighlightedText
                className={`${styles.fileName} ${styles.mono}`}
                text={i.rev}
                indices={i.matches}
                tone="accent"
              />
              <span className={styles.fileDir}>{i.detail}</span>
            </span>
          )}
        />
      </div>
    </Dialog>
  );
}
