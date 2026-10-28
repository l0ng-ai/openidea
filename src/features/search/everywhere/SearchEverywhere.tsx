import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { actionToggled, executeAction, getAction } from "@/platform/actions";
import type { ProjectFileSet } from "@/platform/ipc";
import { tx as translate, useTx } from "@/platform/i18n";
import { hasPrimaryModifier, shortcutLabel } from "@/platform/keymap";
import {
  Checkbox,
  Dialog,
  HighlightedText,
  Icon,
  IconButton,
  List,
  Menu,
  Spinner,
  SymbolBadge,
  Select,
  Toggle,
  fileIconName,
  listNavigate,
  type MenuItem,
  T,
} from "@/ui";
import { useFileDecoration } from "@/workbench/contributions";
import { highlightTokens, languageForPath, type CodeToken } from "@/editor/lsp/markdown";
import { badgeKind, basename, openLocation, relDir } from "../common/open";
import { parseLocationQuery } from "../common/query";
import { CodePreview, type PreviewHighlight } from "../find/parts";
import { SeController, type SeSnapshot } from "./controller";
import { ipcDeps, loadLanguages } from "./deps";
import { extensionIndex, filterActive, isFilterTab, languageOf, resolveFilter } from "./filters";
import { FilterPopup } from "./FilterPopup";
import {
  MORE_STEP_ALL,
  MORE_STEP_TAB,
  SECTION_TITLES,
  TABS,
  buildRows,
  groupJump,
  isSectionRow,
  parseCommand,
  stableIndex,
  topResultSettled,
  type SeRow,
  type SeTab,
  type SectionId,
} from "./model";
import {
  hideSearchEverywhere,
  onSearchEverywhereQuery,
  pushRecentAction,
  pushSearchHistory,
  searchHistory,
  selectSearchEverywhereTab,
  setIncludeNonProject,
  setSearchEverywherePreview,
  useSearchEverywhere,
  widenSearchEverywhere,
} from "./store";
import styles from "./SearchEverywhere.module.css";
import { isImeKey } from "@/platform/ime";

type SeScope = "allPlaces" | ProjectFileSet;

const SE_SCOPES: Array<{ value: SeScope; label: string }> = [
  { value: "allPlaces", label: "All Places" },
  { value: "all", label: "Project Files" },
  { value: "production", label: "Project Production Files" },
  { value: "test", label: "Project Test Files" },
];

const ROW = 24;
const MAX_LIST = 672;
const MIN_LIST = 10 * ROW;
/** List cap while the preview pane takes the lower part of the popup. */
const MAX_LIST_PREVIEW = 312;
const DEBOUNCE_MS = 60;

export function SearchEverywhereOverlay() {
  const open = useSearchEverywhere((s) => s.open);
  return open ? <SearchEverywhereDialog /> : null;
}

type Selection = { key: string | null; index: number; moved: boolean };

function SearchEverywhereDialog() {
  const tx = useTx();
  const tab = useSearchEverywhere((s) => s.tab);
  const query = useSearchEverywhere((s) => s.query);
  const includeNonProject = useSearchEverywhere((s) => s.includeNonProject);
  const fileSet = useSearchEverywhere((s) => s.fileSet);
  const session = useSearchEverywhere((s) => s.session);
  const ctx = useSearchEverywhere((s) => s.ctx);
  const preview = useSearchEverywhere((s) => s.preview);
  const filters = useSearchEverywhere((s) => s.filters);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [debounced, setDebounced] = useState(query);
  const [extra, setExtra] = useState<Partial<Record<SectionId, number>>>({});
  const [snap, setSnap] = useState<SeSnapshot | null>(null);
  const [controller] = useState(() => new SeController(ipcDeps(ctx), setSnap));
  const [sel, setSel] = useState<Selection>({ key: null, index: -1, moved: false });
  const [menu, setMenu] = useState<{
    anchor: Element;
    items: MenuItem[];
    placement: "right-start" | "bottom-start";
  } | null>(null);
  /** Position in the tab's history while ⌥↑/⌥↓ browse it (-1 = the typed draft). */
  const history = useRef({ pos: -1, draft: "" });
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [byExt, setByExt] = useState<ReadonlyMap<string, string> | null>(null);
  const needsLanguages = (tab === "files" || tab === "classes" || tab === "symbols") && filterActive(filters, tab);
  useEffect(() => {
    if (!needsLanguages || byExt) return;
    let alive = true;
    void loadLanguages().then((l) => alive && setByExt(extensionIndex(l)));
    return () => {
      alive = false;
    };
  }, [needsLanguages, byExt]);
  const filter = useMemo(
    () => resolveFilter(filters, tab, byExt ? (path) => languageOf(path, byExt) : undefined),
    [filters, tab, byExt],
  );
  const [toggleTick, setToggleTick] = useState(0);
  const bumpToggles = () => setToggleTick((t) => t + 1);

  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (query === debounced) return;
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, debounced]);

  // New query / scope: forget "Show more" and the user's selection.
  const [prevInputs, setPrevInputs] = useState({ debounced, tab });
  if (prevInputs.debounced !== debounced || prevInputs.tab !== tab) {
    setPrevInputs({ debounced, tab });
    setExtra({});
    setSel({ key: null, index: -1, moved: false });
  }

  // "/fi" lists scope commands instead of searching.
  const listing = useMemo(() => {
    const c = parseCommand(query);
    return c?.kind === "list" ? c.rows : null;
  }, [query]);
  const searchQuery = parseCommand(debounced)?.kind === "list" ? "" : debounced;

  useEffect(() => {
    // A language filter waits for the language list (nothing would be filtered yet).
    if (filter?.excludedLanguages?.length && !filter.languageOf) return;
    controller.run({
      query: searchQuery,
      tab,
      includeNonProject,
      fileSet: tab === "all" ? null : fileSet,
      filter,
      // IDEA: the Actions tab's "everywhere" checkbox is "Include disabled actions".
      includeDisabled: tab === "actions" ? includeNonProject : undefined,
      extra,
    });
  }, [controller, searchQuery, tab, includeNonProject, fileSet, filter, extra]);

  useEffect(() => {
    inputRef.current?.select();
  }, [session]);

  useEffect(() => onSearchEverywhereQuery(query), [query]);

  const parsed = useMemo(() => parseLocationQuery(searchQuery), [searchQuery]);
  // The All tab interleaves its sources by relevance once there is a query.
  const mix = tab === "all" ? parsed.text : undefined;
  const rows = useMemo(
    () => listing ?? (snap ? buildRows(snap.sections, { headers: !parsed.text.trim(), mix }) : []),
    [listing, snap, parsed.text, mix],
  );
  const active = stableIndex(rows, sel.key, sel.index, sel.moved);
  const activeRow = active >= 0 ? rows[active] : undefined;
  // Rows still answer an older query (debounce / in-flight search): Enter must wait.
  const settled =
    !!snap &&
    query === debounced &&
    snap.query === debounced &&
    snap.tab === tab &&
    topResultSettled(snap.sections, mix);
  const pendingEnter = useRef<{ side: boolean } | null>(null);

  const select = (index: number) => setSel({ key: rows[index]?.key ?? null, index, moved: true });
  /** Typed or picked query; "/files foo" switches to Files with "foo". */
  const setQuery = (value: string) => {
    history.current.pos = -1;
    const c = parseCommand(value);
    if (c?.kind === "run") selectSearchEverywhereTab(c.tab, { query: c.rest });
    else useSearchEverywhere.setState({ query: value });
  };
  const browseHistory = (dir: 1 | -1) => {
    const h = searchHistory(tab);
    const cur = history.current;
    const pos = Math.max(-1, Math.min(h.length - 1, cur.pos + dir));
    if (pos === cur.pos) return;
    if (cur.pos < 0) cur.draft = query;
    cur.pos = pos;
    useSearchEverywhere.setState({ query: pos < 0 ? cur.draft : h[pos]! });
  };
  const openHistory = (anchor: Element) => {
    const h = searchHistory(tab).slice(0, 15);
    const items: MenuItem[] = h.length
      ? [
          { kind: "header", label: "Recent Searches" },
          ...h.map((q) => ({ label: q, verbatim: true, run: () => setQuery(q) })),
        ]
      : [{ label: "No recent searches", disabled: true, run: () => {} }];
    setMenu({ anchor, items, placement: "bottom-start" });
  };
  const setTab = (t: SeTab) => {
    history.current.pos = -1;
    selectSearchEverywhereTab(t);
    inputRef.current?.focus();
  };
  const cycleTab = (dir: 1 | -1) => {
    const i = TABS.findIndex((t) => t.id === tab);
    setTab(TABS[(i + dir + TABS.length) % TABS.length]!.id);
  };

  const close = () => hideSearchEverywhere();
  /** Close first so the dialog's focus restore doesn't fight the editor opening. */
  const closeThen = (fn: () => void) => {
    close();
    setTimeout(fn, 0);
  };

  const activate = (row: SeRow | undefined, side = false) => {
    if (!row) return;
    const isResult = row.kind !== "section" && row.kind !== "more" && row.kind !== "command";
    if (isResult && !(row.kind === "action" && !row.enabled)) pushSearchHistory(tab, query);
    switch (row.kind) {
      case "section":
        return;
      case "command":
        selectSearchEverywhereTab(row.tab, { query: "" });
        inputRef.current?.focus();
        return;
      case "more": {
        const step = tab === "all" ? MORE_STEP_ALL : MORE_STEP_TAB;
        setExtra((e) => ({ ...e, [row.section]: (e[row.section] ?? 0) + step }));
        setSel({ key: null, index: rows.indexOf(row), moved: true });
        return;
      }
      case "file":
        return closeThen(
          () => void openLocation(row.path, row.line !== null ? { line: row.line, col: row.col ?? 0 } : null, { side }),
        );
      case "symbol":
        return closeThen(() => void openLocation(row.path, { line: row.line, col: row.col }, { side }));
      case "text":
        return closeThen(
          () =>
            void openLocation(
              row.path,
              { line: row.line, col: row.col, endLine: row.line, endCol: row.endCol },
              { side },
            ),
        );
      case "action":
        if (!row.enabled) return;
        pushRecentAction(row.id);
        if (getAction(row.id)?.toggled) {
          void executeAction(row.id).then(() => bumpToggles());
          return;
        }
        return closeThen(() => void executeAction(row.id));
      case "setting":
        return closeThen(() => void executeAction("file.settings", row.pageId));
    }
  };

  useEffect(() => {
    const pending = pendingEnter.current;
    if (!pending || !settled) return;
    pendingEnter.current = null;
    activate(activeRow, pending.side);
  });

  /** IDEA's ⌥↵ on an action: record a shortcut for it (written to the active keymap). */
  const assignShortcut = (id: string) => closeThen(() => void executeAction("settings.assignShortcut", id));

  const openIntentions = () => {
    const row = activeRow;
    if (!row || row.kind === "section" || row.kind === "more" || row.kind === "command") return;
    if (row.kind === "action") return assignShortcut(row.id);
    const anchor = listRef.current?.querySelector('[aria-selected="true"]') ?? inputRef.current;
    if (!anchor) return;
    const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
    const items: MenuItem[] =
      row.kind === "setting"
        ? [{ label: "Open Settings Page", run: () => activate(row) }]
        : [
            { label: "Open", run: () => activate(row) },
            { label: "Open to the Side", shortcut: "⇧↵", run: () => activate(row, true) },
            { kind: "separator" },
            { label: "Copy Path", run: () => copy(row.path) },
            { label: "Copy Path from Project Root", run: () => copy(row.rel) },
            ...(row.kind === "symbol" ? [{ label: "Copy Name", run: () => copy(row.name) }] : []),
            ...(row.kind === "file" || row.kind === "text"
              ? [
                  {
                    label: "Find in Directory…",
                    run: () => closeThen(() => void executeAction("find.inPath", { directory: dirOf(row.path) })),
                  },
                ]
              : []),
          ];
    setMenu({ anchor, items, placement: "right-start" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.altKey) openIntentions();
      else if (hasPrimaryModifier(e) && tab === "text")
        closeThen(() => void executeAction("find.inPath", { query: parsed.text }));
      else if (listing) activate(activeRow);
      else if (!settled && !sel.moved) pendingEnter.current = { side: e.shiftKey };
      else activate(activeRow, e.shiftKey);
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      browseHistory(e.key === "ArrowUp" ? 1 : -1);
      return;
    }
    const groupKey =
      e.key === "PageDown" ||
      e.key === "PageUp" ||
      (hasPrimaryModifier(e) && (e.key === "ArrowDown" || e.key === "ArrowUp"));
    if (groupKey) {
      const jump = groupJump(rows, active, e.key === "PageDown" || e.key === "ArrowDown" ? 1 : -1);
      if (jump !== null) {
        e.preventDefault();
        select(jump);
        return;
      }
    }
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) return;
    const next = listNavigate(e.key, { items: rows, active, isSection: isSectionRow, wrap: true, pageSize: 10 });
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  const maxList = preview ? MAX_LIST_PREVIEW : MAX_LIST;
  // While a query is typed the list keeps a minimum height so the popup doesn't jump with every keystroke.
  const minList = parsed.text.trim() && !listing ? MIN_LIST : 0;
  const listHeight = Math.min(maxList, Math.max(minList, rows.length * ROW));
  const previewTarget = previewOf(activeRow);
  const emptyQuery = !parsed.text.trim();
  const showEmpty = !rows.length && snap && !snap.loading && (!emptyQuery || tab !== "all");
  // Nothing in the project: retry everywhere (IDEA), unless the user picked the scope.
  const nothingInProject =
    !!showEmpty &&
    !emptyQuery &&
    !listing &&
    !includeNonProject &&
    query === debounced &&
    snap.query === searchQuery &&
    snap.tab === tab;
  useEffect(() => {
    if (nothingInProject) widenSearchEverywhere(searchQuery);
  }, [nothingInProject, searchQuery]);
  const canSplit = activeRow?.kind === "file" || activeRow?.kind === "symbol" || activeRow?.kind === "text";
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    cycleTab(e.key === "ArrowRight" ? 1 : -1);
  };

  return (
    <Dialog
      open
      onClose={close}
      width={760}
      position="top"
      transparentBackdrop
      aria-label={tx("Search Everywhere")}
      className={styles.dialog}
    >
      <div className={styles.header}>
        <div role="tablist" aria-label={tx("Search scope")} className={styles.tabs} onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              tabIndex={t.id === tab ? 0 : -1}
              className={clsx(styles.tab, t.id === tab && styles.tabActive)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTab(t.id)}
            >
              <T>{t.label}</T>
            </button>
          ))}
        </div>
        {tab === "all" || tab === "actions" ? (
          <Checkbox
            className={styles.include}
            checked={includeNonProject}
            onChange={(v) => {
              setIncludeNonProject(v);
              inputRef.current?.focus();
            }}
            label={tab === "actions" ? "Include disabled actions" : "Include non-project items"}
          />
        ) : (
          // IDEA's scope chooser of the Classes / Files / Symbols / Text tabs.
          <Select<SeScope>
            variant="ghost"
            className={clsx(styles.include, styles.scope)}
            value={includeNonProject ? "allPlaces" : fileSet}
            options={SE_SCOPES}
            onChange={(v) => {
              if (v === "allPlaces") setIncludeNonProject(true);
              else setIncludeNonProject(false, { fileSet: v });
              inputRef.current?.focus();
            }}
            aria-label="Search scope"
          />
        )}
        <IconButton
          icon="list"
          size="small"
          className={styles.headerButton}
          title={tx("Preview")}
          pressed={preview}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setSearchEverywherePreview(!preview)}
        />
        {isFilterTab(tab) && (
          <IconButton
            icon="filter"
            size="small"
            className={styles.headerButton}
            title={tx("Filter")}
            pressed={filterActive(filters, tab)}
            aria-haspopup="dialog"
            aria-expanded={!!filterAnchor}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => setFilterAnchor(filterAnchor ? null : e.currentTarget)}
          />
        )}
        <IconButton
          icon="open-in-tool-window"
          size="small"
          className={styles.headerButton}
          title={tx("Open in Find Tool Window")}
          shortcut={tab === "text" ? "⌘↵" : undefined}
          onClick={() => closeThen(() => void executeAction("find.inPath", { query: parsed.text }))}
        />
      </div>
      <div className={styles.queryRow}>
        <div className={styles.field}>
          <button
            type="button"
            className={styles.magnifier}
            aria-label={tx("Search history")}
            title={tx("Search history (⌥↑ / ⌥↓)")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => openHistory(e.currentTarget)}
          >
            <Icon name="search" size={16} />
            <Icon name="chevron-down" size={10} />
          </button>
          <input
            id="se-query"
            ref={inputRef}
            data-autofocus
            className={styles.query}
            value={query}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            role="combobox"
            aria-expanded
            aria-controls="se-results"
            aria-autocomplete="list"
            aria-label={tx("Search query")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {snap?.loading && !emptyQuery && <Spinner size={14} className={styles.spinner} />}
          {hintFor(tab) && (
            <span className={styles.hint} aria-hidden>
              <T>{hintFor(tab)}</T>
            </span>
          )}
        </div>
      </div>
      {(rows.length > 0 || showEmpty) && (
        <div
          ref={listRef}
          id="se-results"
          className={styles.results}
          style={{ height: rows.length ? listHeight + 8 : undefined }}
        >
          {rows.length > 0 && (
            <List<SeRow>
              items={rows}
              getKey={(r) => r.key}
              isSection={isSectionRow}
              renderSection={(r) => (
                <span className={styles.section}>{r.kind === "section" ? <T>{r.title}</T> : ""}</span>
              )}
              activeIndex={active}
              onActiveChange={select}
              onActivate={(r, _i, e) => activate(r, (e as MouseEvent).shiftKey)}
              focusable={false}
              rowHeight={ROW}
              sectionHeight={ROW}
              className={styles.list}
              aria-label={tx("Results")}
              renderItem={(r, state) => (
                <ResultRow
                  row={r}
                  active={state.active}
                  repeat={sameFile(rows[state.index - 1], r)}
                  toggleTick={toggleTick}
                  onToggled={bumpToggles}
                />
              )}
            />
          )}
          {showEmpty && (
            <div className={styles.empty}>
              {tx(
                emptyQuery ? "Type to search" : includeNonProject ? "Nothing found" : "Nothing found in project files",
              )}
            </div>
          )}
        </div>
      )}
      {!rows.length && !showEmpty && <div id="se-results" ref={listRef} hidden />}
      {preview && rows.length > 0 && (
        <div className={styles.preview}>
          <CodePreview
            path={previewTarget?.path ?? null}
            line={previewTarget?.line ?? 0}
            highlights={previewTarget?.highlights ?? []}
          />
        </div>
      )}
      {rows.length > 0 && (
        <footer className={styles.footer}>
          <span className={styles.footerInfo}>{describe(activeRow)}</span>
          {canSplit && (
            <button type="button" className={styles.footerLink} onClick={() => activate(activeRow, true)}>
              <T>Open In Right Split</T>
            </button>
          )}
        </footer>
      )}
      {filterAnchor && isFilterTab(tab) && (
        <FilterPopup
          tab={tab}
          filters={filters}
          anchor={filterAnchor}
          onClose={() => {
            setFilterAnchor(null);
            inputRef.current?.focus();
          }}
        />
      )}
      <Menu
        open={!!menu}
        anchor={menu?.anchor ?? null}
        items={menu?.items ?? []}
        placement={menu?.placement ?? "right-start"}
        onClose={() => {
          setMenu(null);
          inputRef.current?.focus();
        }}
      />
    </Dialog>
  );
}

function describe(row: SeRow | undefined): string {
  if (!row) return "";
  switch (row.kind) {
    case "section":
    case "more":
    case "command":
      return "";
    case "action": {
      const a = getAction(row.id);
      const text = a?.description ?? (row.category ? `${row.category} | ${row.title}` : row.title);
      return `${text}  ·  ${translate("⌥↵ to assign a shortcut")}`;
    }
    case "setting":
      return [...row.path, row.title].map((p) => translate(p)).join(" | ");
    case "file":
      return row.rel;
    case "symbol":
    case "text":
      return `${row.rel}:${row.line + 1}`;
  }
}

function previewOf(row: SeRow | undefined): { path: string; line: number; highlights: PreviewHighlight[] } | null {
  switch (row?.kind) {
    case "file":
      return { path: row.path, line: row.line ?? 0, highlights: [] };
    case "symbol":
      return {
        path: row.path,
        line: row.line,
        highlights: [{ line: row.line, ranges: [[row.col, row.col + row.name.length]] }],
      };
    case "text":
      return { path: row.path, line: row.line, highlights: [{ line: row.line, ranges: [[row.col, row.endCol]] }] };
    default:
      return null;
  }
}

function hintFor(tab: SeTab): string {
  switch (tab) {
    case "all":
      return "Type / to see commands";
    case "text":
      return "⌘↵ to open in Find tool window";
    default:
      return "";
  }
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

/** A text hit in the same file as the row above (its file name is dimmed, like IDEA). */
function sameFile(prev: SeRow | undefined, row: SeRow): boolean {
  return row.kind === "text" && prev?.kind === "text" && prev.path === row.path;
}

function ResultRow({
  row,
  active,
  repeat,
  toggleTick,
  onToggled,
}: {
  row: SeRow;
  active: boolean;
  repeat: boolean;
  toggleTick: number;
  onToggled: () => void;
}) {
  const tx = useTx();
  const tone = "strong";
  switch (row.kind) {
    case "section":
      return null;
    case "command":
      return (
        <>
          <Icon name="search" size={16} className={styles.icon} />
          <span className={styles.main}>
            <span className={styles.name}>{row.name}</span>
          </span>
          <span className={styles.right}>
            <T>{row.label}</T>
          </span>
        </>
      );
    case "more":
      return (
        <span className={clsx(styles.name, styles.more)}>
          … {tx("more")} {tx(SECTION_TITLES[row.section]).toLowerCase()}
        </span>
      );
    case "file":
      return <FileRow path={row.path} name={row.name} dir={row.dir} indices={row.nameIndices} line={row.line} />;
    case "symbol":
      return (
        <>
          <SymbolBadge kind={badgeKind(row.symbolKind)} className={styles.icon} />
          <span className={styles.main}>
            <HighlightedText className={styles.name} text={row.display} indices={row.indices} tone={tone} />
            {row.container && <span className={styles.location}>{row.container}</span>}
          </span>
          <span className={styles.right}>
            {row.section === "classes" ? relDir(row.rel) || basename(row.rel) : basename(row.rel)}
          </span>
        </>
      );
    case "action": {
      const shortcut = shortcutLabel(row.id);
      const toggled = actionToggled(getAction(row.id));
      return (
        <span
          className={clsx(styles.actionRow, !row.enabled && styles.disabled)}
          aria-disabled={!row.enabled || undefined}
        >
          <span className={styles.icon}>{row.icon ? <Icon name={row.icon} size={16} /> : null}</span>
          <span className={styles.main}>
            <HighlightedText className={styles.name} text={row.title} indices={row.indices} tone={tone} />
            {shortcut && <span className={clsx(styles.location, styles.shortcut)}>{shortcut}</span>}
          </span>
          {toggled !== undefined ? (
            <span
              className={styles.toggle}
              data-tick={toggleTick}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.preventDefault()}
            >
              <Toggle
                checked={toggled}
                disabled={!row.enabled}
                aria-label={row.title}
                onChange={() => {
                  pushRecentAction(row.id);
                  void executeAction(row.id).then(onToggled);
                }}
              />
            </span>
          ) : (
            row.category && <span className={styles.right}>{row.category}</span>
          )}
        </span>
      );
    }
    case "setting":
      return (
        <>
          <span className={styles.icon}>
            <Icon name="settings" size={16} />
          </span>
          <span className={styles.main}>
            <HighlightedText className={styles.name} text={row.title} indices={row.indices} tone={tone} />
          </span>
          <span className={styles.right}>
            {tx("Settings")}
            {row.path.length ? `: ${row.path.map((p) => tx(p)).join(" | ")}` : ""}
          </span>
        </>
      );
    case "text":
      return (
        <>
          <span className={styles.icon}>
            <Icon name="text-match" size={16} />
          </span>
          <span className={styles.main}>
            <CodeText path={row.path} text={row.text} indices={row.indices} />
          </span>
          <span className={clsx(styles.right, active && styles.rightActive)}>
            <span className={clsx(repeat && !active && styles.repeat)}>{basename(row.rel)}</span> {row.line + 1}
          </span>
        </>
      );
  }
}

const tokenCache = new Map<string, CodeToken[]>();

/** A text hit's line, syntax-coloured by the file's language (one line parsed on its own). */
function CodeText({ path, text, indices }: { path: string; text: string; indices: readonly number[] }) {
  const language = useMemo(() => languageForPath(path), [path]);
  const key = `${language}\u0000${text}`;
  const [loaded, setLoaded] = useState<{ key: string; tokens: CodeToken[] } | null>(null);
  const tokens = tokenCache.get(key) ?? (loaded?.key === key ? loaded.tokens : null);
  useEffect(() => {
    if (tokens || !language) return;
    let alive = true;
    void highlightTokens(text, language).then((t) => {
      tokenCache.set(key, t);
      if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value!);
      if (alive) setLoaded({ key, tokens: t });
    });
    return () => {
      alive = false;
    };
  }, [key, language, text, tokens]);

  const parts: Array<[number, number, string]> = [];
  let pos = 0;
  for (const t of tokens ?? []) {
    if (t.from > pos) parts.push([pos, t.from, ""]);
    parts.push([t.from, t.to, t.cls]);
    pos = t.to;
  }
  if (pos < text.length) parts.push([pos, text.length, ""]);
  return (
    <span className={clsx(styles.name, styles.code)}>
      {parts.map(([s, e, cls]) => (
        <HighlightedText
          key={s}
          className={cls || undefined}
          text={text.slice(s, e)}
          indices={indices.filter((i) => i >= s && i < e).map((i) => i - s)}
        />
      ))}
    </span>
  );
}

function FileRow({
  path,
  name,
  dir,
  indices,
  line,
}: {
  path: string;
  name: string;
  dir: string;
  indices: number[];
  line: number | null;
}) {
  const deco = useFileDecoration(path);
  return (
    <>
      <Icon name={fileIconName(name)} size={16} className={styles.icon} />
      <span className={styles.main}>
        <span className={styles.name} style={deco.color ? { color: deco.color } : undefined}>
          <HighlightedText text={name} indices={indices} tone="strong" />
          {line !== null && <span className={styles.lineSuffix}>:{line + 1}</span>}
        </span>
        {dir && <span className={styles.location}>{dir}</span>}
      </span>
    </>
  );
}
