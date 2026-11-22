import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { isMacHost } from "@/platform/keymap";
import { Icon, IconButton, SearchField, type MenuItem } from "@/ui";
import clsx from "clsx";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BranchFilterPopup } from "../BranchFilterPopup";
import { chooseDateRange, chooseMany } from "../dialogs";
import styles from "../GitLog.module.css";
import { LogIdContext } from "../logContext";
import { useLogOptions, type LogOptions } from "../logOptions";
import {
  ME,
  dateRangeLabel,
  goToRef,
  openLogTab,
  recentFilterValues,
  recentLogFilters,
  reloadLog,
  recentFilterKey,
  setLogBranches,
  setLogFilters,
  toggleRepository,
  updateLogOptions,
  useGitLog,
} from "../logStore";
import { relTo } from "../model";
import { branchesByRepo } from "../multiRoot";
import { chooseLogPaths, editLogPaths } from "../PathFilterDialog";
import { openExternalLog } from "../RevisionBrowser";
import { currentRepo, repoName, useVcs } from "../store";
import { useDropdownMenu, useLogRepositories, useReadOnlyLog } from "./logHooks";
import { toggle } from "./shared";

// --- filters ----------------------------------------------------------------

const DAY = 86_400_000;

const DATE_OPTIONS: { label: string; days: number }[] = [
  { label: "Last 24 Hours", days: 1 },
  { label: "Last 7 Days", days: 7 },
  { label: "Last 30 Days", days: 30 },
  { label: "Last Year", days: 365 },
];

interface LogFilter {
  label: string;
  value: string | null;
  onOpen: (anchor: HTMLElement) => void;
  onClear: () => void;
}

function FilterButton({ label, value, onOpen, onClear, hidden }: LogFilter & { hidden?: boolean }) {
  return (
    <span
      className={clsx(styles.filterButton, value && styles.filterActive, hidden && styles.filterHidden)}
      inert={hidden}
    >
      <button type="button" className={styles.filterMain} onClick={(e) => onOpen(e.currentTarget)} aria-haspopup="menu">
        {value ? (
          <>
            {tx(label)}: <span className={styles.filterValue}>{value}</span>
          </>
        ) : (
          tx(label)
        )}
        {!value && <Icon name="chevron-down" size={12} className={styles.filterChevron} />}
      </button>
      {value && (
        <IconButton
          type="button"
          className={styles.filterClear}
          aria-label={tx`Clear ${tx(label)} filter`}
          onClick={onClear}
          icon="close"
          size="small"
        />
      )}
    </span>
  );
}

export function FilterBar({ fileHistory = false }: { fileHistory?: boolean }) {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const logGeneration = useGitLog((s) => s.generation);
  const filters = useGitLog((s) => s.filters);
  const commits = useGitLog((s) => s.commits);
  const selectedBranches = useVcs((s) => s.branches);
  const [branches, setBranches] = useState(selectedBranches);
  const version = useVcs((s) => s.version);
  const root = useVcs((s) => s.root);
  const repositories = useLogRepositories();
  const readOnly = useReadOnlyLog();
  const bookmarks = useGitLog((s) => s.bookmarks);
  const showBranches = useLogOptions((s) => s.showBranches);
  useEffect(() => {
    let live = true;
    const roots = filters.repositories?.length ? filters.repositories : repositories;
    void branchesByRepo(roots)
      .then((all) => {
        if (live)
          setBranches([
            ...new Map(
              Object.values(all)
                .flat()
                .map((b) => [b.name, b]),
            ).values(),
          ]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repositories, filters.repositories, version, logGeneration]);
  const [text, setText] = useState(filters.text);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
  const [menuBelow, dropdown] = useDropdownMenu();
  // Filters that do not fit move behind a chevron, like a toolbar's overflow.
  const groupRef = useRef<HTMLSpanElement>(null);
  const [hiddenFrom, setHiddenFrom] = useState(Infinity);
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const items = [...group.children] as HTMLElement[];
      const i = items.findIndex((el) => el.offsetLeft + el.offsetWidth > group.clientWidth + 1);
      setHiddenFrom(i < 0 ? Infinity : i);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(group);
    for (const el of group.children) ro.observe(el);
    return () => ro.disconnect();
  }, [filters, repositories.length]);

  // Keep the field in sync when filters change elsewhere (Show History, reveal).
  const [seen, setSeen] = useState(filters);
  if (seen !== filters) {
    setSeen(filters);
    setText(filters.text);
  }

  useEffect(() => {
    if (!active || text === filters.text) return;
    const t = setTimeout(() => setLogFilters({ text }), 300);
    return () => clearTimeout(t);
  }, [text, filters.text, active]);

  const branchNames = () => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => b.name);

  const selectBranches = async () => {
    setBranchAnchor(null);
    const r = await chooseMany({
      title: "Filter by Branch",
      options: [
        ...new Set([
          "HEAD",
          ...branchNames(),
          ...recentFilterValues("branches").flat(),
          ...recentFilterValues("range").filter((s): s is string => !!s),
        ]),
      ],
      initial: filters.branches,
      customLabel: "Branches, patterns, exclusions or ranges (comma-separated):",
    });
    if (r) setLogBranches(r);
  };

  const openUser = async (anchor: HTMLElement) => {
    const roots = filters.repositories?.length
      ? filters.repositories
      : repositories.length
        ? repositories
        : [currentRepo()];
    const users = await Promise.all(roots.map((repo) => call(commands.vcsLogUsers(repo)).catch(() => [] as string[])));
    const authors = [...new Set(users.flat().concat(commits.map((c) => `${c.author} <${c.email}>`)))].sort((a, b) =>
      a.localeCompare(b),
    );
    menuBelow(anchor, [
      ...recentFilterValues("authors").map((authors) => ({
        label: authors.join(", "),
        run: () => setLogFilters({ authors }),
      })),
      { label: ME, checked: filters.authors.includes(ME), run: () => setLogFilters({ authors: [ME] }) },
      ...(authors.length ? [{ kind: "separator" as const }] : []),
      ...authors.slice(0, 30).map((a) => ({
        label: a,
        checked: filters.authors.includes(a),
        run: () => setLogFilters({ authors: [a] }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseMany({
            title: "Filter by User",
            options: [ME, ...authors],
            initial: filters.authors,
            customLabel: "Other names or emails (comma-separated):",
          });
          if (r) setLogFilters({ authors: r });
        },
      },
    ]);
  };

  const openDate = (anchor: HTMLElement) =>
    menuBelow(anchor, [
      ...recentFilterValues("date")
        .filter((date) => date != null)
        .map((date) => ({ label: date.label, run: () => setLogFilters({ date }) })),
      ...DATE_OPTIONS.map((o) => ({
        label: o.label,
        checked: filters.date?.label === o.label,
        run: () => setLogFilters({ date: { after: Date.now() - o.days * DAY, before: null, label: o.label } }),
      })),
      { kind: "separator" },
      {
        label: "Select…",
        run: async () => {
          const r = await chooseDateRange();
          if (r) setLogFilters({ date: { ...r, label: dateRangeLabel(r.after, r.before) } });
        },
      },
    ]);

  const paths = filters.paths?.length ? filters.paths : filters.path ? [filters.path] : [];
  const pathRoots = repositories.length ? repositories : root ? [root] : [];
  const pathLabel = (path: string) => (root ? relTo(root, path) : path) || ".";
  const selectedRepositories = filters.repositories?.length ? filters.repositories : repositories;
  const selectPaths = (paths: string[]) => setLogFilters({ path: null, paths, repositories: [] });
  const selectRepositories = (selected: string[]) =>
    setLogFilters({
      path: null,
      paths: [],
      repositories: selected.length === repositories.length ? [] : selected,
    });
  const openPaths = (anchor: HTMLElement) => {
    const modifier = isMacHost() ? "⌘" : "Ctrl";
    const repositoryItems: MenuItem[] =
      repositories.length > 1
        ? [
            { kind: "header", label: "Repositories" },
            ...[...repositories]
              .sort((a, b) => repoName(a).localeCompare(repoName(b)))
              .map((repo) => {
                const name = repoName(repo);
                const checked = !paths.length && selectedRepositories.includes(repo);
                return {
                  label: name,
                  verbatim: true,
                  checked,
                  hint: tx`${modifier}+Click to only see "${name}"`,
                  run: () => {
                    const selected = paths.length ? [repo] : toggleRepository(selectedRepositories, repo);
                    if (selected.length) selectRepositories(selected);
                  },
                  runWithModifier: () => selectRepositories([repo]),
                };
              }),
          ]
        : [];
    const pathKey = recentFilterKey("paths", paths);
    const history = recentFilterValues("paths");
    const recentSets = paths.length
      ? [paths, ...history.filter((recent) => recentFilterKey("paths", recent) !== pathKey)].slice(0, 10)
      : history;
    const recentItems: MenuItem[] = recentSets.flatMap((recent) =>
      recent?.length
        ? [
            {
              label: recent.map(pathLabel).join(", "),
              verbatim: true,
              checked: recent.length === paths.length && recent.every((path) => paths.includes(path)),
              run: () => selectPaths(recent),
            },
          ]
        : [],
    );
    if (recentItems.length) recentItems.unshift({ kind: "header", label: "Recent" });
    menuBelow(anchor, [
      {
        label: "Select…",
        run: async () => {
          const selected = await editLogPaths(pathRoots, paths);
          if (selected) selectPaths(selected);
        },
      },
      {
        label: "Select in Tree…",
        run: async () => {
          const selected = await chooseLogPaths(pathRoots, paths, readOnly);
          if (selected) selectPaths(selected);
        },
      },
      ...(repositories.length > 15 ? [...recentItems, ...repositoryItems] : [...repositoryItems, ...recentItems]),
      ...(paths.length || filters.repositories?.length
        ? [{ kind: "separator" as const }, { label: "All", run: () => selectPaths([]) }]
        : []),
    ]);
  };

  const logFilters: LogFilter[] = [
    {
      label: "Branch",
      value: filters.range || filters.branches.join(", ") || null,
      onOpen: (anchor: HTMLElement) => setBranchAnchor((open) => (open === anchor ? null : anchor)),
      onClear: () => setLogBranches([]),
    },
    {
      label: "User",
      value: filters.authors.join(", ") || null,
      onOpen: openUser,
      onClear: () => setLogFilters({ authors: [] }),
    },
    {
      label: "Date",
      value: filters.date?.label ?? null,
      onOpen: openDate,
      onClear: () => setLogFilters({ date: null }),
    },
    {
      label: "Paths",
      value: paths.length ? paths.map(pathLabel).join(", ") : filters.repositories?.map(repoName).join(", ") || null,
      onOpen: openPaths,
      onClear: () => selectPaths([]),
    },
  ];

  return (
    <div className={styles.filters} role="toolbar" aria-label={tx("Log filters")}>
      <div className={styles.filterControls}>
        {!fileHistory && !showBranches && (
          <IconButton icon="chevron-right" title="Show Branches" size="small" action="vcs.log.showBranches" />
        )}
        <SearchField
          className={styles.textFilter}
          value={text}
          onChange={setText}
          placeholder="Text or hash"
          aria-label="Filter by message"
          toggles={[
            {
              id: "regex",
              icon: "regex",
              title: "Regex",
              pressed: filters.regex,
              onToggle: (regex) => setLogFilters({ regex }),
            },
            {
              id: "case",
              icon: "case",
              title: "Match Case",
              pressed: filters.matchCase,
              onToggle: (matchCase) => setLogFilters({ matchCase }),
            },
          ]}
        />
        <span ref={groupRef} className={styles.filterGroup}>
          {logFilters.map((f, i) => (
            <FilterButton key={f.label} {...f} hidden={i >= hiddenFrom} />
          ))}
        </span>
        {hiddenFrom < logFilters.length && (
          <IconButton
            icon="chevron-right"
            title="More Filters"
            size="small"
            aria-haspopup="menu"
            onClick={(e) => {
              const anchor = e.currentTarget;
              menuBelow(
                anchor,
                logFilters.slice(hiddenFrom).map((f) => ({
                  label: f.value ? `${tx(f.label)}: ${f.value}` : f.label,
                  run: () => f.onOpen(anchor),
                })),
              );
            }}
          />
        )}
      </div>
      {dropdown}
      {branchAnchor && (
        <BranchFilterPopup
          anchor={branchAnchor}
          branches={branches}
          selected={filters.branches}
          onClose={() => setBranchAnchor(null)}
          onSelect={(branch) => {
            setLogBranches([branch]);
            setBranchAnchor(null);
          }}
          onSelectMany={() => void selectBranches()}
        />
      )}
      <div className={styles.filterActions}>
        <IconButton
          icon="bookmark"
          title="Bookmarked Commits"
          size="small"
          disabled={!Object.keys(bookmarks).length}
          onClick={(e) =>
            menuBelow(
              e,
              Object.entries(bookmarks).map(([key, summary]) => ({
                label: summary,
                run: () => {
                  const split = key.lastIndexOf("\0");
                  void goToRef(key.slice(split + 1), split >= 0 ? key.slice(0, split) : undefined);
                },
              })),
            )
          }
        />
        <IconButton
          icon="plus"
          title="Open Another Log Tab"
          size="small"
          onClick={(e) =>
            menuBelow(e, [
              {
                label: "In Tool Window",
                run: () => {
                  openLogTab("log", `Log ${useGitLog.getState().logTabs.length + 1}`);
                },
              },
              {
                label: "In Editor",
                run: () => {
                  openLogTab("log", `Log ${useGitLog.getState().logTabs.length + 1}`, "editor");
                },
              },
              { label: "External Repository…", run: openExternalLog },
            ])
          }
        />
        <IconButton
          icon="clock"
          title="Recent Filters"
          size="small"
          onClick={(e) =>
            menuBelow(
              e,
              recentLogFilters().map((filters) => ({
                label:
                  [
                    filters.range,
                    filters.branches.join(", "),
                    filters.authors.join(", "),
                    filters.text,
                    filters.path,
                    filters.paths?.join(", "),
                    filters.date?.label,
                  ]
                    .filter(Boolean)
                    .join(" · ") || tx("All commits"),
                run: () => setLogFilters(filters),
              })),
            )
          }
        />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void reloadLog({ preserve: true })} />
        <IconButton
          icon="sort"
          title="Graph Options"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => menuBelow(e, graphOptionsMenu(useLogOptions.getState()))}
        />
        <IconButton
          icon="eye"
          title="View Options"
          size="small"
          aria-haspopup="menu"
          onClick={(e) => menuBelow(e, viewOptionsMenu(useLogOptions.getState()))}
        />
        <IconButton icon="search" title="Go to Hash/Branch/Tag" size="small" action="vcs.log.goToRef" />
      </div>
    </div>
  );
}

/** IDEA's Git Log › Graph Options (sort, first parent / no merges, linear branches). */
export function graphOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Sort" },
    { label: "By Commit Date", checked: o.sort === "date", run: () => updateLogOptions({ sort: "date" }) },
    { label: "Topologically", checked: o.sort === "topo", run: () => updateLogOptions({ sort: "topo" }) },
    {
      label: "Incoming Commits First",
      checked: o.sort === "standard",
      run: () => updateLogOptions({ sort: "standard" }),
    },
    { kind: "separator" },
    { kind: "header", label: "Options" },
    toggle("First Parent", o, "firstParent"),
    toggle("No Merges", o, "noMerges"),
    {
      label: "Linearize Merges",
      checked: o.linearizeMerges,
      run: () =>
        updateLogOptions({ linearizeMerges: !o.linearizeMerges, ...(!o.linearizeMerges ? { sort: "standard" } : {}) }),
    },
    { kind: "separator" },
    { kind: "header", label: "Branch Actions" },
    { kind: "action", action: "vcs.log.collapseLinear" },
    { kind: "action", action: "vcs.log.expandLinear" },
  ];
}

/** IDEA's Git Log › View Options (what rows show and highlight). */
export function viewOptionsMenu(o: LogOptions): MenuItem[] {
  return [
    { kind: "header", label: "Show" },
    toggle("Compact References View", o, "compactRefs"),
    toggle("Tag Names", o, "tagNames"),
    toggle("Long Edges", o, "longEdges"),
    toggle("Commit Timestamp", o, "commitTimestamp"),
    toggle("References on the Left", o, "refsOnLeft"),
    toggle("Details", o, "showDetails"),
    toggle("Repository", o, "showRepository"),
    {
      label: "Columns",
      submenu: [
        toggle("Author", o, "showAuthor"),
        toggle("Date", o, "showDate"),
        toggle("Hash", o, "showHash"),
        toggle("Signature", o, "showSignature"),
        toggle("GitHub Commit Checks", o, "showGitHubChecks"),
        { kind: "separator" },
        toggle("Column Headers", o, "showColumnHeaders"),
        toggle("Column Dividers", o, "showColumnDividers"),
      ],
    },
    { kind: "separator" },
    { kind: "header", label: "Highlight" },
    toggle("My Commits", o, "highlightMine"),
    toggle("Merge Commits", o, "highlightMerges"),
    toggle("Current Branch", o, "highlightCurrentBranch"),
  ];
}
