import { branchesByRepo } from "./multiRoot";
/** Title bar branch widget (branch name + incoming / outgoing markers) + Branches popup. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type { Branch, BranchInfo } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { bindingsFor, normalizeBinding, registerKeyClaim, shortcutLabel, strokeOf } from "@/platform/keymap";
import { useEditorRegistry } from "@/editor/api";
import {
  BarButton,
  HighlightedText,
  Icon,
  IconButton,
  List,
  listNavigate,
  Menu,
  MenuList,
  Popup,
  SearchField,
  firstSelectable,
  type MenuItem,
  T,
} from "@/ui";
import { buildBranchRows, withExpanded, type BranchRow, type PopupAction } from "./branches";
import { branchMenu, commonBranchMenu, inRepo, tagMenu } from "./branchMenu";
import { loadFavoriteBranches, recentBranches, toggleFavoriteBranch, useFavoriteBranches } from "./branchOps";
import { inProgress, operationTitle, type InProgress } from "./operations";
import {
  buildMultiRepoRows,
  currentRepoFor,
  repoHeadLabel,
  widgetShowsRepo,
  type RepoEntry,
  type RepoRow,
} from "./repoBranches";
import { currentRepo, focusRepo, loadBranches, repoName, useVcs } from "./store";
import styles from "./BranchWidget.module.css";
import { tx } from "@/platform/i18n";

export const useBranchesPopup = create<{ open: boolean }>(() => ({ open: false }));
export const showBranchesPopup = () => useBranchesPopup.setState({ open: true });

export function headLabel(branch: { head: string | null; headCommit: string | null } | null): string {
  if (!branch) return "";
  if (branch.head) return branch.head;
  return branch.headCommit ? branch.headCommit.slice(0, 8) : tx("No commits");
}

/** The current repository (see `currentRepoFor`): the widget and the popup show the same one. */
function useCurrentRepo(): string | null {
  const path = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  return useVcs((s) => currentRepoFor(path, s.roots, s.repo));
}

export function BranchWidget() {
  const available = useVcs((s) => s.available);
  const selected = useVcs((s) => s.branch);
  const count = useVcs((s) => s.roots.length);
  const current = useCurrentRepo();
  // Several repositories on different branches: the widget names the current one.
  const diverged = useVcs((s) => widgetShowsRepo(s.roots.map((r) => ({ head: s.heads[r]?.head ?? null }))));
  // The current repository is not the selected one: its HEAD from the last scan (no upstream).
  const other = useVcs((s) => (diverged && current && current !== s.repo ? (s.heads[current] ?? null) : null));
  const otherOp = useVcs((s) => (current ? (s.operations[current] ?? null) : null));
  const open = useBranchesPopup((s) => s.open);
  const ref = useRef<HTMLButtonElement>(null);
  if (!available || !selected) return null;
  const repo = diverged && current ? repoName(current) : null;
  const branch: BranchInfo = other
    ? { head: other.head, headCommit: other.headCommit, upstream: null, ahead: 0, behind: 0, operation: otherOp }
    : selected;
  const head = branch.operation ? `${headLabel(branch)} (${branch.operation})` : headLabel(branch);
  const sync =
    branch.behind > 0 && branch.ahead > 0
      ? tx`${branch.behind} incoming, ${branch.ahead} outgoing commits`
      : branch.behind > 0
        ? tx`${branch.behind} incoming commits`
        : branch.ahead > 0
          ? tx`${branch.ahead} outgoing commits`
          : "";
  const tooltip = [
    repo ? tx`Repository: ${repo}` : "",
    tx`Git branch: ${head}`,
    branch.upstream ? tx`Tracking ${branch.upstream}` : "",
    count > 1 && !repo ? tx`In all ${count} repositories` : "",
    sync,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <BarButton
        ref={ref}
        variant="title"
        className={styles.widget}
        tooltip={tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => useBranchesPopup.setState({ open: !open })}
      >
        <Icon name={branch.head ? "branch" : "commit"} size={16} className={styles.icon} />
        {repo && <span className={styles.repo}>{repo}</span>}
        <span className={styles.name}>
          {inProgress(branch.operation)
            ? operationTitle(inProgress(branch.operation)!, branch.head)
            : headLabel(branch)}
        </span>
        {branch.operation && !inProgress(branch.operation) && (
          <span className={styles.operation}>{branch.operation}</span>
        )}
        {/* Like IDEA's widget: icons only; counts are in the tooltip. */}
        {branch.behind > 0 && (
          <Icon name="vcs-incoming" size={12} className={clsx(styles.sync, styles.incoming)} label="Incoming commits" />
        )}
        {branch.ahead > 0 && (
          <Icon name="vcs-outgoing" size={12} className={clsx(styles.sync, styles.outgoing)} label="Outgoing commits" />
        )}
        <Icon name="chevron-down" size={14} className={styles.chevron} />
      </BarButton>
      {open && <BranchesPopup anchor={ref} onClose={() => useBranchesPopup.setState({ open: false })} />}
    </>
  );
}

const POPUP_ACTIONS: PopupAction[] = [
  { id: "vcs.update", label: "Update Project…", icon: "git-pull", group: "sync" },
  { id: "vcs.commit", label: "Commit…", icon: "commit", group: "sync" },
  { id: "vcs.push", label: "Push…", icon: "git-push", group: "sync" },
  { id: "vcs.newBranch", label: "New Branch…", icon: "plus", group: "branch" },
  { id: "vcs.checkoutRevision", label: "Checkout Tag or Revision…", icon: "branch", group: "branch" },
];

/** A single repository's own entries (its submenu in the popup with several repositories). */
const REPO_ACTIONS: PopupAction[] = [
  { id: "vcs.newBranch", label: "New Branch…", icon: "plus", group: "branch" },
  { id: "vcs.checkoutRevision", label: "Checkout Tag or Revision…", icon: "branch", group: "branch" },
];

const OPTIONS_KEY = "openidea.vcs.branchesPopup.options";

interface PopupOptions {
  groupByPrefix: boolean;
  showRecent: boolean;
  showTags: boolean;
}

function loadOptions(): PopupOptions {
  const out: PopupOptions = { groupByPrefix: true, showRecent: true, showTags: true };
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (v && typeof v === "object")
      for (const k of Object.keys(out) as (keyof PopupOptions)[]) {
        const x = (v as Record<string, unknown>)[k];
        if (typeof x === "boolean") out[k] = x;
      }
  } catch {
    // Storage unavailable: defaults.
  }
  return out;
}

/** The popup's gear options (Group by Prefix, Show Recent Branches, Show Tags), kept across sessions. */
const usePopupOptions = create<PopupOptions>(loadOptions);

function toggleOption(key: keyof PopupOptions) {
  usePopupOptions.setState((s) => ({ [key]: !s[key] }));
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(usePopupOptions.getState()));
  } catch {
    // Kept for this session only.
  }
}

/** Groups and folders the user expanded or collapsed, remembered for the session (per popup kind). */
const useExpansion = create<{ single: ReadonlyMap<string, boolean>; multi: ReadonlyMap<string, boolean> }>(() => ({
  single: new Map(),
  multi: new Map(),
}));

function useExpanded(kind: "single" | "multi") {
  const expanded = useExpansion((s) => s[kind]);
  const setOpen = (key: string, open: boolean) =>
    useExpansion.setState((s) => (s[kind].get(key) === open ? s : { [kind]: withExpanded(s[kind], key, open) }));
  return [expanded, setOpen] as const;
}

/** Whether a keystroke is New Branch's shortcut (⌥⌘N, shared with Inline: the popup claims it). */
function isNewBranchStroke(stroke: string | null): boolean {
  if (!stroke) return false;
  const s = normalizeBinding(stroke);
  return bindingsFor("vcs.newBranch").some((b) => normalizeBinding(b) === s);
}

function OptionsButton({ hasTags }: { hasTags: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const options = usePopupOptions();
  const items: MenuItem[] = [
    { label: "Group by Prefix", checked: options.groupByPrefix, run: () => toggleOption("groupByPrefix") },
    { label: "Show Recent Branches", checked: options.showRecent, run: () => toggleOption("showRecent") },
    ...(hasTags ? [{ label: "Show Tags", checked: options.showTags, run: () => toggleOption("showTags") }] : []),
  ];
  return (
    <>
      <IconButton
        icon="settings"
        title="Options"
        size="small"
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      {anchor && (
        <Menu
          open
          anchor={anchor}
          placement="bottom-end"
          items={items}
          onClose={() => setAnchor(null)}
          aria-label="Branches Popup Options"
        />
      )}
    </>
  );
}

/** Entries IDEA puts at the top of the Branches popup while an operation is stopped. */
export function operationActions(op: InProgress | null, conflicts: number): PopupAction[] {
  if (!op) return [];
  const out: PopupAction[] = [];
  if (conflicts) out.push({ id: "vcs.resolveConflicts", label: "Resolve Conflicts…", icon: "warning" });
  const ids: Record<InProgress, Array<[string, string]>> = {
    rebase: [
      ["vcs.rebase.continue", "Continue Rebase"],
      ["vcs.rebase.skip", "Skip Commit"],
      ["vcs.rebase.abort", "Abort Rebase"],
    ],
    merge: [["vcs.merge.abort", "Abort Merge"]],
    "cherry-pick": [
      ["vcs.cherryPick.continue", "Continue Cherry-Pick"],
      ["vcs.cherryPick.abort", "Abort Cherry-Pick"],
    ],
    revert: [
      ["vcs.revert.continue", "Continue Revert"],
      ["vcs.revert.abort", "Abort Revert"],
    ],
    am: [],
  };
  for (const [id, label] of ids[op]) out.push({ id, label });
  return out;
}

const NO_BRANCHES: readonly Branch[] = [];
const INDENT = 16;
const ROW_HEIGHT = 24;
const SEPARATOR_HEIGHT = 9;
const listHeight = (rows: readonly { type: string; key: string }[]) =>
  Math.min(
    440,
    Math.max(
      ROW_HEIGHT * 3,
      rows.reduce(
        (h, r) => h + (r.type === "section" && r.key.startsWith("separator:") ? SEPARATOR_HEIGHT : ROW_HEIGHT),
        0,
      ),
    ),
  );

/** The option element of the row with `key`, to anchor a submenu on. */
function rowElement(list: HTMLElement | null, key: string): HTMLElement | null {
  const el = list?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
  return el ? ((el.closest('[role="option"]') as HTMLElement | null) ?? el) : null;
}

/** Caret at the end (→ opens) / start (← closes) of the search field. */
const caretAt = (e: KeyboardEvent, where: "start" | "end") => {
  const input = e.target as HTMLInputElement;
  if (input.selectionStart !== input.selectionEnd) return false;
  return where === "end" ? input.selectionStart === input.value.length : input.selectionStart === 0;
};

function BranchesPopup({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const multi = useVcs((s) => s.roots.length > 1);
  // ⌥⌘N is also Inline (enabled while a popup is open over an editor): the search field handles it here.
  useEffect(() => registerKeyClaim((_e, stroke) => isNewBranchStroke(stroke)), []);
  return (
    <Popup
      open
      anchor={anchor}
      onClose={onClose}
      placement="bottom-start"
      aria-label="Git Branches"
      className={clsx(styles.popup, multi && styles.wide)}
    >
      {multi ? <MultiRepoPanel onClose={onClose} /> : <BranchesPanel onClose={onClose} actions={POPUP_ACTIONS} />}
    </Popup>
  );
}

interface BranchesPanelProps {
  onClose: () => void;
  actions: readonly PopupAction[];
  /** A repository other than the selected one (the submenu of a repository): it is selected before acting. */
  root?: string;
  /** Its branches until the selected repository's are loaded. */
  fallback?: readonly Branch[];
  /** ← at the start of the search field (back to the repositories). */
  onBack?: () => void;
}

/** Search, actions and the branches of one repository (the selected one, or `root`). */
function BranchesPanel({ onClose, actions: baseActions, root, fallback, onBack }: BranchesPanelProps) {
  const selected = useVcs((s) => s.repo);
  const live = root === undefined || selected === root;
  const storeBranches = useVcs((s) => s.branches);
  const storeLoaded = useVcs((s) => s.branchesLoaded);
  const branches = live && (storeLoaded || !fallback) ? storeBranches : (fallback ?? NO_BRANCHES);
  const loaded = (live && storeLoaded) || !!fallback;
  const current = useVcs((s) =>
    live ? (s.branch?.head ?? null) : root ? (s.heads[root]?.head ?? null) : (s.branch?.head ?? null),
  );
  const [query, setQuery] = useState("");
  const [recent] = useState(recentBranches);
  const [active, setActive] = useState(0);
  const [menuFor, setMenuFor] = useState<{ items: MenuItem[]; label: string; el: HTMLElement } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const favorites = useFavoriteBranches((s) => s.names);
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    if (root === undefined) void loadBranches().catch(() => undefined);
    loadFavoriteBranches();
  }, [root]);
  useEffect(() => {
    let live = true;
    call(commands.vcsTags(root ?? currentRepo())).then(
      (t) => live && setTags(t),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [root, selected, branches]);

  const op = useVcs((s) => inProgress(root ? s.operations[root] : s.branch?.operation));
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const actions = useMemo(() => [...operationActions(op, conflicts), ...baseActions], [op, conflicts, baseActions]);
  const options = usePopupOptions();
  const [expanded, setOpen] = useExpanded("single");
  const rows = useMemo(
    () => buildBranchRows(branches, recent, query, actions, favorites, tags, { ...options, expanded }),
    [branches, recent, query, actions, favorites, tags, options, expanded],
  );
  const isSection = (r: BranchRow) => r.type === "section";
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);
  const scoped = (items: MenuItem[]) => (root ? inRepo(root, items) : items);

  const closeAll = () => {
    setMenuFor(null);
    onClose();
  };
  const openMenu = (i: number) => {
    const row = rows[i];
    if (row?.type !== "branch" && row?.type !== "tag") return;
    const el = rowElement(listRef.current, row.key);
    if (!el) return;
    setMenuFor(
      row.type === "branch"
        ? { items: scoped(branchMenu(row.branch, current, closeAll)), label: tx`Branch ${row.branch.name}`, el }
        : { items: scoped(tagMenu(row.tag, closeAll)), label: tx`Tag ${row.tag}`, el },
    );
  };

  const run = (id: string, arg?: unknown) => {
    onClose();
    void (root ? focusRepo(root) : Promise.resolve()).then(() => executeAction(id, arg));
  };
  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.type === "action") {
      run(row.action.id, row.action.arg);
    } else if (row.type === "group") {
      if (!query.trim()) setOpen(row.key, !row.expanded);
    } else if (row.type === "branch" || row.type === "tag") {
      openMenu(i);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isNewBranchStroke(strokeOf(e))) {
      e.preventDefault();
      run("vcs.newBranch");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(activeIndex);
      return;
    }
    const row = rows[activeIndex];
    if (e.key === "ArrowRight" && (row?.type === "branch" || row?.type === "tag" || row?.type === "group")) {
      if (caretAt(e, "end")) {
        e.preventDefault();
        if (row.type !== "group") openMenu(activeIndex);
        else if (!query.trim()) setOpen(row.key, true);
      }
      return;
    }
    if (e.key === "ArrowLeft" && row?.type === "group" && row.expanded && !query.trim() && caretAt(e, "start")) {
      e.preventDefault();
      setOpen(row.key, false);
      return;
    }
    if (e.key === "ArrowLeft" && onBack && caretAt(e, "start")) {
      e.preventDefault();
      onBack();
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const label = root ? `Search branches of ${repoName(root)}` : "Search branches and actions";
  return (
    <>
      <div className={styles.search}>
        <SearchField
          className={root ? styles.searchGrow : undefined}
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          placeholder={label}
          aria-label={label}
          variant="bare"
          onKeyDown={onKeyDown}
        />
        {!root && <IconButton icon="git-fetch" title="Fetch" size="small" action="vcs.fetch" />}
        {!root && <OptionsButton hasTags={tags.length > 0} />}
      </div>
      <div ref={listRef} style={{ height: listHeight(rows) }} className={styles.listWrap}>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          sectionHeightOf={(r) => (r.type === "section" && !r.label ? SEPARATOR_HEIGHT : undefined)}
          renderSection={(r) =>
            r.type === "section" && r.label ? (
              <span className={styles.section}>{tx(r.label)}</span>
            ) : (
              <span className={styles.separator} role="separator" />
            )
          }
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={(_r, i) => activate(i)}
          focusable={false}
          hoverSelects
          rowHeight={ROW_HEIGHT}
          aria-label="Branches"
          className={styles.list}
          empty={<span className={styles.empty}>{loaded ? tx("No matching branches") : tx("Loading…")}</span>}
          renderItem={(r) => (r.type === "group" ? <GroupRowView row={r} /> : <BranchRowView row={r} />)}
        />
      </div>
      {menuFor && <SubMenu {...menuFor} onClose={() => setMenuFor(null)} />}
    </>
  );
}

function SubMenu({
  items,
  label,
  el,
  onClose,
}: {
  items: MenuItem[];
  label: string;
  el: HTMLElement;
  onClose: () => void;
}) {
  return (
    <Popup
      open
      anchor={el}
      placement="right-start"
      offset={2}
      role="presentation"
      autoFocus={false}
      onClose={onClose}
      className={styles.menuPopup}
    >
      <MenuList items={items} onDone={onClose} onCloseLevel={onClose} aria-label={label} />
    </Popup>
  );
}

/**
 * Branches popup of a project with several repositories: actions; the repositories,
 * each opening its own branches (on hover or →); then the branches they all have
 * (acting on all of them) or, when their branches differ, the current repository's.
 */
function MultiRepoPanel({ onClose }: { onClose: () => void }) {
  const roots = useVcs((s) => s.roots);
  const heads = useVcs((s) => s.heads);
  const operations = useVcs((s) => s.operations);
  const version = useVcs((s) => s.version);
  const favorites = useFavoriteBranches((s) => s.names);
  const current = useCurrentRepo();
  const [recent] = useState(recentBranches);
  const [tags, setTags] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [expanded, setOpen] = useExpanded("multi");
  const options = usePopupOptions();
  const [all, setAll] = useState<Record<string, Branch[]>>({});
  const [menuFor, setMenuFor] = useState<{ items: MenuItem[]; label: string; el: HTMLElement } | null>(null);
  const [repoMenu, setRepoMenu] = useState<{ root: string; el: HTMLElement; focus: boolean } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** Back from a repository's submenu to the search field. */
  const closeRepoMenu = () => {
    setRepoMenu(null);
    searchRef.current?.focus();
  };

  useEffect(() => loadFavoriteBranches(), []);
  // Every repository's branches (common ones, submenus, search); refreshed after operations.
  useEffect(() => {
    let live = true;
    void branchesByRepo(roots)
      .then((entries) => live && setAll(entries))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [roots, version]);
  useEffect(() => {
    let live = true;
    if (current)
      call(commands.vcsTags(current)).then(
        (t) => live && setTags(t),
        () => live && setTags([]),
      );
    return () => {
      live = false;
    };
  }, [current, version]);

  const repos = useMemo<RepoEntry[]>(
    () =>
      roots.map((root) => ({
        root,
        name: repoName(root),
        head: heads[root]?.head ?? null,
        headCommit: heads[root]?.headCommit ?? null,
      })),
    [roots, heads],
  );
  const op = useVcs((s) => inProgress(s.branch?.operation));
  const conflicts = useVcs((s) => s.status.filter((f) => f.unstaged === "conflicted").length);
  const actions = useMemo(
    () => [
      ...operationActions(op, conflicts),
      ...POPUP_ACTIONS.map((a) => (a.id === "vcs.newBranch" ? { ...a, arg: { repos: roots } } : a)),
    ],
    [op, conflicts, roots],
  );
  const rows = useMemo(
    () =>
      buildMultiRepoRows({
        ...options,
        repos,
        branches: all,
        query,
        actions,
        expanded,
        favorites,
        current,
        recent,
        tags,
      }),
    [repos, all, query, actions, expanded, favorites, current, recent, tags, options],
  );
  const isSection = (r: RepoRow) => r.type === "section";
  const activeIndex = rows[active] && !isSection(rows[active]!) ? active : firstSelectable(rows, isSection);

  const closeAll = () => {
    setMenuFor(null);
    setRepoMenu(null);
    onClose();
  };
  /** Opens the submenu of row `i`; `focus` moves the keyboard into a repository's submenu. */
  const openSub = (i: number, focus: boolean) => {
    const row = rows[i];
    if (!row) return;
    const el = rowElement(listRef.current, row.key);
    if (!el) return;
    if (row.type === "repo") {
      setMenuFor(null);
      setRepoMenu((prev) =>
        prev?.root === row.repo.root && prev.el === el && prev.focus === focus
          ? prev
          : { root: row.repo.root, el, focus },
      );
      return;
    }
    setRepoMenu(null);
    if (row.type === "common") {
      setMenuFor({ items: commonBranchMenu(row.branch, roots, closeAll), label: tx`Branch ${row.branch.name}`, el });
    } else if (row.type === "branch") {
      const items = inRepo(row.repo.root, branchMenu(row.branch, row.repo.head, closeAll));
      setMenuFor({ items, label: tx`Branch ${row.branch.name} of ${row.repo.name}`, el });
    } else if (row.type === "tag") {
      setMenuFor({ items: inRepo(row.repo.root, tagMenu(row.tag, closeAll)), label: tx`Tag ${row.tag}`, el });
    }
  };
  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.type === "action") {
      onClose();
      void executeAction(row.action.id, row.action.arg);
    } else if (row.type === "group") {
      if (!query.trim()) setOpen(row.key, !row.expanded);
    } else {
      openSub(i, true);
    }
  };
  // The pointer on a repository opens its branches right away; elsewhere it closes them.
  const hover = (i: number) => {
    setActive(i);
    if (rows[i]?.type === "repo") openSub(i, false);
    else setRepoMenu(null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isNewBranchStroke(strokeOf(e))) {
      e.preventDefault();
      onClose();
      void executeAction("vcs.newBranch", { repos: roots });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activate(activeIndex);
      return;
    }
    const row = rows[activeIndex];
    if (e.key === "ArrowRight" && row && row.type !== "action" && row.type !== "section") {
      if (!caretAt(e, "end")) return;
      e.preventDefault();
      if (row.type === "group") {
        if (!query.trim()) setOpen(row.key, true);
      } else openSub(activeIndex, true);
      return;
    }
    if (e.key === "ArrowLeft" && row?.type === "group" && row.expanded) {
      if (!caretAt(e, "start") || query.trim()) return;
      e.preventDefault();
      setOpen(row.key, false);
      return;
    }
    const next = listNavigate(e.key, { items: rows, active: activeIndex, isSection, wrap: true });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  return (
    <>
      <div className={styles.search}>
        <SearchField
          ref={searchRef}
          className={styles.searchGrow}
          data-autofocus
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          placeholder="Search for branches, actions, repositories"
          aria-label="Search for branches, actions, repositories"
          variant="bare"
          onKeyDown={onKeyDown}
        />
        <IconButton icon="git-fetch" title="Fetch" size="small" action="vcs.fetch" />
        <OptionsButton hasTags={tags.length > 0} />
      </div>
      <div ref={listRef} style={{ height: listHeight(rows) }} className={styles.listWrap}>
        <List
          items={rows}
          getKey={(r) => r.key}
          isSection={isSection}
          sectionHeightOf={(r) => (r.type === "section" && !r.label ? SEPARATOR_HEIGHT : undefined)}
          renderSection={(r) =>
            r.type === "section" && r.label ? (
              <span className={styles.section}>{tx(r.label)}</span>
            ) : (
              <span className={styles.separator} role="separator" />
            )
          }
          activeIndex={activeIndex}
          onActiveChange={hover}
          onActivate={(_r, i) => activate(i)}
          focusable={false}
          hoverSelects
          rowHeight={ROW_HEIGHT}
          aria-label="Repositories and branches"
          className={styles.list}
          empty={
            <span className={styles.empty}>
              <T>No matching repositories or branches</T>
            </span>
          }
          renderItem={(r) => (
            <RepoRowView row={r} operation={r.type === "repo" ? operations[r.repo.root] : undefined} />
          )}
        />
      </div>
      {menuFor && <SubMenu {...menuFor} onClose={() => setMenuFor(null)} />}
      {repoMenu && (
        <Popup
          open
          anchor={repoMenu.el}
          placement="right-start"
          offset={2}
          autoFocus={repoMenu.focus}
          aria-label={tx`Branches of ${repoName(repoMenu.root)}`}
          onClose={closeRepoMenu}
          className={styles.popup}
        >
          <BranchesPanel
            key={repoMenu.root}
            root={repoMenu.root}
            fallback={all[repoMenu.root]}
            actions={REPO_ACTIONS}
            onClose={closeAll}
            onBack={closeRepoMenu}
          />
        </Popup>
      )}
    </>
  );
}

function RepoRowView({ row, operation }: { row: RepoRow; operation?: string }) {
  switch (row.type) {
    case "action":
    case "branch":
    case "tag":
      return <BranchRowView row={row} />;
    case "repo":
      return (
        <span className={styles.row} data-row-key={row.key}>
          <span
            className={styles.repoColor}
            style={{ background: `var(--project-color-${row.color})` }}
            aria-hidden="true"
          />
          <HighlightedText className={styles.label} text={row.repo.name} indices={row.matches} tone="accent" />
          {operation && <span className={styles.operation}>{operation}</span>}
          <span className={styles.repoHead}>{repoHeadLabel(row.repo)}</span>
          <Icon name="chevron-right" size={10} className={styles.subChevron} />
        </span>
      );
    case "group":
      return <GroupRowView row={row} />;
    case "common":
      return (
        <span className={styles.row} data-row-key={row.key} style={{ paddingLeft: row.depth * INDENT }}>
          <Icon
            name={row.branch.current ? "current-branch" : row.branch.favorite ? "star" : "branch"}
            size={14}
            className={clsx(styles.rowIcon, row.branch.current && styles.currentIcon)}
          />
          <HighlightedText
            className={clsx(styles.label, styles.branchName, row.branch.current && styles.current)}
            text={row.label}
            indices={row.matches}
            tone="accent"
          />
          {row.branch.current && (
            <span className={styles.tag}>
              <T>current</T>
            </span>
          )}
          <Icon name="chevron-right" size={10} className={styles.chevron} />
        </span>
      );
    default:
      return null;
  }
}

/** A collapsible group (Recent / Local / Remote / Tags) or a prefix folder. Folder names are not translated. */
function GroupRowView({ row }: { row: { key: string; label: string; expanded: boolean; depth: number } }) {
  return (
    <span
      className={clsx(styles.row, row.depth === 0 && styles.groupRow)}
      data-row-key={row.key}
      style={row.depth ? { paddingLeft: row.depth * INDENT } : undefined}
      aria-expanded={row.expanded}
    >
      <Icon name={row.expanded ? "chevron-down" : "chevron-right"} size={12} className={styles.rowIcon} />
      {row.depth > 0 && <Icon name="folder" size={14} className={styles.rowIcon} />}
      <span className={styles.label}>{row.depth > 0 ? row.label : tx(row.label)}</span>
    </span>
  );
}

function BranchRowView({ row }: { row: BranchRow | Extract<RepoRow, { type: "action" | "branch" | "tag" }> }) {
  const indent = "depth" in row && row.depth ? { paddingLeft: row.depth * INDENT } : undefined;
  if (row.type === "action") {
    const keys = shortcutLabel(row.action.id);
    return (
      <span className={styles.row} data-row-key={row.key}>
        <Icon name={row.action.icon ?? "more"} size={14} className={styles.rowIcon} />
        <HighlightedText className={styles.label} text={tx(row.action.label)} indices={row.matches} tone="accent" />
        {keys && <span className={styles.keys}>{keys}</span>}
      </span>
    );
  }
  if (row.type === "tag") {
    return (
      <span className={styles.row} data-row-key={row.key} style={indent}>
        <Icon name="tag" size={14} className={styles.rowIcon} />
        <HighlightedText
          className={clsx(styles.label, styles.branchName)}
          text={row.tag}
          indices={row.matches}
          tone="accent"
        />
        <Icon name="chevron-right" size={10} className={styles.chevron} />
      </span>
    );
  }
  if (row.type !== "branch") return null;
  const b = row.branch;
  return (
    <span className={styles.row} data-row-key={row.key} style={indent}>
      {b.current ? (
        <Icon name="current-branch" size={14} className={clsx(styles.rowIcon, styles.currentIcon)} />
      ) : (
        // Like IDEA: favorites show a star; others show an empty star on hover. Click toggles.
        <button
          type="button"
          className={clsx(styles.star, row.favorite && styles.starOn)}
          aria-label={row.favorite ? tx("Remove from Favorites") : tx("Add to Favorites")}
          aria-pressed={row.favorite}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavoriteBranch(b);
          }}
        >
          <Icon name={row.favorite ? "star" : "star-outline"} size={14} className={styles.starIcon} />
          {!row.favorite && <Icon name="branch" size={14} className={styles.branchIcon} />}
        </button>
      )}
      <HighlightedText
        className={clsx(styles.label, styles.branchName, b.current && styles.current)}
        text={row.label}
        indices={row.matches}
        tone="accent"
      />
      {b.current && (
        <span className={styles.tag}>
          <T>current</T>
        </span>
      )}
      {/* Like IDEA: incoming (↙) before outgoing (↗). */}
      {b.behind > 0 && (
        <span className={clsx(styles.syncSmall, styles.incoming)} title={tx`${b.behind} incoming commits`}>
          <Icon name="vcs-incoming" size={12} />
          {b.behind}
        </span>
      )}
      {b.ahead > 0 && (
        <span className={clsx(styles.syncSmall, styles.outgoing)} title={tx`${b.ahead} outgoing commits`}>
          <Icon name="vcs-outgoing" size={12} />
          {b.ahead}
        </span>
      )}
      {!b.remote && b.upstream && <span className={styles.upstream}>{b.upstream}</span>}
      <Icon name="chevron-right" size={10} className={styles.chevron} />
    </span>
  );
}
