/**
 * IDEA-style Find / Replace bar at the top of the editor (⌘F / ⌘R): search
 * field with Match Case / Words / Regex toggles (⌥C / ⌥W / ⌥X), New Line
 * (⇧⌘↵, multi-line queries), recent searches (magnifier ▾ / ⌥↓), the filter
 * menu (Search In Selection ⌥E — on by default when Replace opens over a
 * multi-line selection — and the search scope: anywhere, in / except comments
 * and string literals), n/N counter, ↑/↓ (⇧↵ / ↵), Replace / Replace All /
 * Exclude with Preserve Case, Esc closes. `FindPanel` is the bar itself, for
 * any CodeMirror view (the diff viewer's sides); `FindBar` is it on an editor pane.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import type { EditorView } from "@codemirror/view";
import { Button, IconButton, Menu, SearchField, T, type MenuItem } from "@/ui";
import { SEARCH_CONTEXTS, rememberSearch, searchHistory } from "@/platform/search";
import { editorController, useFindBars, useTabs } from "../controller";
import {
  countMatches,
  excludeCurrent,
  findNext,
  findPrevious,
  findScope,
  findResultLines,
  isExcluded,
  regexValid,
  replaceAll,
  replaceNext,
  setFindMarks,
  setFindOpen,
  setFindScope,
  setQuery,
  type FindOptions,
  type FindScope,
} from "../cm/find";
import styles from "./EditorArea.module.css";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { showFindResults, type FindResultsSource } from "@/workbench/contributions";
import { relativePath, useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import {
  bindingsFor,
  formatBinding,
  hasPrimaryModifier,
  normalizeBinding,
  registerKeyClaim,
  shortcutLabel,
} from "@/platform/keymap";

/**
 * The last search (IDEA's find-in-file model): a newly opened bar starts from it and ⌘G
 * uses it without a bar. Each open bar then keeps its own copy (`useFindSessions`).
 */
export const useFindOptions = create<Required<FindOptions>>(() => ({
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
  context: "any",
  preserveCase: false,
}));
/** The query and options of each open bar, by target id: bars on other files don't share them. */
export const useFindSessions = create<Record<string, Required<FindOptions> | undefined>>(() => ({}));

function optionsOf(id: string): Required<FindOptions> {
  return useFindSessions.getState()[id] ?? useFindOptions.getState();
}

/** Changes a bar's options; like IDEA, the last search follows them. */
function updateOptions(id: string, patch: (o: Required<FindOptions>) => Partial<FindOptions>) {
  const current = optionsOf(id);
  const next = { ...current, ...patch(current) };
  useFindSessions.setState({ [id]: next });
  useFindOptions.setState(next);
}

interface Counts {
  total: number;
  current: number;
  capped: boolean;
  /** The selection is an excluded match (Exclude reads "Include"). */
  excluded: boolean;
}
const useFindCounts = create<Record<string, Counts | null>>(() => ({}));
/** Whether the bar of a pane is limited to a selection ("In Selection"). */
const useFindScoped = create<Record<string, boolean>>(() => ({}));
/** The selection the bar was opened over, for toggling "In Selection" on later. */
const openSelections = new Map<string, FindScope>();

/** The editor a find bar searches. */
export interface FindTarget {
  /** Keys the bar's counter and selection scope. */
  id: string;
  view(): EditorView | null;
  /** Calls `fn` on document / selection changes of the searched editor; returns the unsubscribe. */
  watch(fn: (u: { docChanged: boolean; selectionSet: boolean }) => void): () => void;
  /** Still open: an unmount that isn't a close (React's dev-mode remount) keeps the highlights. */
  isOpen(): boolean;
  results?(options: FindOptions): FindResultsSource | null;
}

const activeTab = (paneId: string) => useTabs.getState().panes[paneId]?.active ?? null;

const tabTargets = new Map<string, FindTarget>();

/** The editor of a tab: each tab has its own bar, like IDEA's per-editor search session. */
function tabTarget(tabId: string): FindTarget {
  let target = tabTargets.get(tabId);
  if (!target) {
    target = {
      id: tabId,
      view: () => editorController().slotFor(tabId)?.view ?? null,
      watch(fn) {
        const slot = editorController().slotFor(tabId);
        if (!slot) return () => {};
        slot.listeners.add(fn);
        return () => void slot.listeners.delete(fn);
      },
      isOpen: () => !!useFindBars.getState()[tabId],
      results(options) {
        const slot = editorController().slotFor(tabId);
        if (!slot) return null;
        const state = slot.currentState();
        const scope = state.field(findScope, false) ?? { from: 0, to: state.doc.length };
        const path = slot.ctx.path;
        const root = useProject.getState().project?.root;
        return {
          title: tx`Occurrences of '${options.search}'`,
          query: {
            pattern: options.search,
            isRegex: options.regexp,
            caseSensitive: options.caseSensitive,
            wholeWord: options.wholeWord,
            context: options.context,
            include: [],
            exclude: [],
            scope: { kind: "files", paths: [path] },
            maxMatches: 0,
          },
          read: () => {
            const current = slot.disposed ? state : slot.currentState();
            return {
              path,
              relPath: root ? relativePath(root, path) : path,
              matches: findResultLines(
                current,
                options,
                state.field(findScope, false)
                  ? (current.field(findScope, false) ?? scope)
                  : { from: 0, to: current.doc.length },
              ),
            };
          },
        };
      },
    };
    tabTargets.set(tabId, target);
  }
  return target;
}

export const useFindPreferences = create(() => ({ scrollToResults: true }));
const panelTargets = new Map<string, FindTarget>();
let focusedTarget: FindTarget | undefined;

export function findPanelTarget(arg?: unknown): FindTarget | undefined {
  return typeof arg === "string" ? panelTargets.get(arg) : focusedTarget;
}

export function openFindBarResults(arg?: unknown) {
  const target = findPanelTarget(arg);
  if (!target) return;
  const opts = optionsOf(target.id);
  if (!opts.search || (opts.regexp && !regexValid(opts.search))) return;
  const source = target.results?.({ ...opts });
  if (source?.read().matches.length) {
    rememberQuery(target.id, false);
    showFindResults(source);
  }
}

/** Longest selection that becomes the query. */
const MAX_QUERY = 10_000;

/**
 * Opens (or refocuses) the bar, as in IDEA: the
 * selection becomes the query — multi-line too — and the search covers the
 * file, except that Replace over a multi-line selection searches in it. A
 * multi-line query isn't kept for a later search without a selection.
 */
export function openFindBar(paneId: string, replace: boolean) {
  const tabId = activeTab(paneId);
  if (!tabId) return;
  seedFind(tabTarget(tabId), replace);
  useFindBars.setState((s) => ({ [tabId]: { replace, seq: (s[tabId]?.seq ?? 0) + 1 } }));
}

/**
 * The query and scope a bar opening over `target`'s selection starts with (see openFindBar).
 * As in IDEA, a new bar copies the last search; an open one keeps its own query.
 */
export function seedFind(target: FindTarget, replace: boolean) {
  const view = target.view();
  const sel = view?.state.selection.main;
  const open = !!useFindSessions.getState()[target.id];
  const set = (patch: (o: Required<FindOptions>) => Partial<FindOptions>) => {
    if (open) updateOptions(target.id, patch);
    else
      useFindSessions.setState({ [target.id]: { ...useFindOptions.getState(), ...patch(useFindOptions.getState()) } });
  };
  if (view && sel && !sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    const multiline = text.includes("\n");
    openSelections.set(target.id, { from: sel.from, to: sel.to });
    if (multiline && replace) {
      view.dispatch({ effects: setFindScope.of({ from: sel.from, to: sel.to }) });
      set(() => ({ search: "" }));
    } else {
      view.dispatch({ effects: setFindScope.of(null) });
      if (text.length < MAX_QUERY)
        set((o) => ({ search: o.regexp ? text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : text }));
      else set(() => ({}));
    }
  } else set((o) => (o.search.includes("\n") ? { search: "" } : {}));
}

/** Show / Hide Replace on the open bar, keeping its query and scope. */
function setReplaceShown(tabId: string, replace: boolean) {
  useFindBars.setState((s) => ({ [tabId]: { replace, seq: s[tabId]?.seq ?? 0 } }));
}

/** ⌘G / ⇧⌘G: next / previous occurrence of the bar's search, or of the last one without a bar. */
export function findAgain(paneId: string, forward: boolean) {
  const tabId = activeTab(paneId);
  if (!tabId) return;
  const target = tabTarget(tabId);
  if (!target.view()) return;
  if (!searchAgain(target, forward)) openFindBar(paneId, false);
}

/** Next / previous occurrence of `target`'s search; false without a usable query. */
export function searchAgain(target: FindTarget, forward: boolean): boolean {
  const view = target.view();
  const opts = optionsOf(target.id);
  if (!view || !opts.search || (opts.regexp && !regexValid(opts.search))) return false;
  setQuery(view, opts);
  if (forward) findNext(view);
  else findPrevious(view);
  if (target.isOpen()) recount(target);
  return true;
}

/** Toggles "In Selection": limit to the selection the bar was opened over (or the current one). */
function toggleScope(target: FindTarget) {
  const view = target.view();
  if (!view) return;
  if (view.state.field(findScope, false)) {
    view.dispatch({ effects: setFindScope.of(null) });
  } else {
    const main = view.state.selection.main;
    const len = view.state.doc.length;
    const saved = openSelections.get(target.id);
    const range = saved && saved.to <= len && saved.to - saved.from > main.to - main.from ? saved : main;
    if (range.to <= range.from) return;
    view.dispatch({ effects: setFindScope.of({ from: range.from, to: range.to }) });
  }
  recount(target);
}

function recount(target: FindTarget) {
  const view = target.view();
  if (!view) return;
  const opts = optionsOf(target.id);
  const r = countMatches(view.state);
  const { from, to } = view.state.selection.main;
  useFindCounts.setState({ [target.id]: opts.search ? { ...r, excluded: isExcluded(view.state, from, to) } : null });
  useFindScoped.setState({ [target.id]: !!view.state.field(findScope, false) });
  view.dispatch({ effects: setFindMarks.of(opts.search ? r.starts : []) });
}

function rememberQuery(id: string, replace: boolean) {
  const o = optionsOf(id);
  rememberSearch("find", o.search);
  if (replace) rememberSearch("replace", o.replace);
}

export function FindBar({ paneId }: { paneId: string }) {
  const tabId = useTabs((s) => s.panes[paneId]?.active ?? null);
  const bar = useFindBars((s) => (tabId ? s[tabId] : undefined));
  if (!tabId || !bar) return null;
  const target = tabTarget(tabId);
  return (
    <FindPanel
      key={tabId}
      target={target}
      version={tabId}
      replace={bar.replace}
      seq={bar.seq}
      onReplaceShown={(replace) => setReplaceShown(tabId, replace)}
      onClose={() => {
        useFindBars.setState({ [tabId]: undefined });
        target.view()?.focus();
      }}
    />
  );
}

export interface FindPanelProps {
  target: FindTarget;
  /** Changes when the target's view does (another tab, a rebuilt viewer). */
  version: unknown;
  replace: boolean;
  /** Bumped by each open (⌘F again): refocuses the field. */
  seq: number;
  /** Show / Hide Replace; without it the bar only finds. */
  onReplaceShown?: (replace: boolean) => void;
  /** Closes the bar (the owner unmounts it) and focuses the editor. */
  onClose(): void;
}

export function FindPanel({ target, version, replace, seq, onReplaceShown, onClose }: FindPanelProps) {
  const id = target.id;
  const lastOptions = useFindOptions();
  const opts = useFindSessions((s) => s[id]) ?? lastOptions;
  const count = useFindCounts((s) => s[id] ?? null);
  const scoped = useFindScoped((s) => !!s[id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const findBoxRef = useRef<HTMLDivElement>(null);
  const replaceBoxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const scrollToResults = useFindPreferences((s) => s.scrollToResults);
  const [moreMenu, setMoreMenu] = useState(false);
  const filterRef = useRef<HTMLButtonElement>(null);
  const [historyMenu, setHistoryMenu] = useState<"find" | "replace" | null>(null);
  const [filterMenu, setFilterMenu] = useState(false);
  const setOpts = (patch: Partial<FindOptions>) => updateOptions(id, () => patch);

  useLayoutEffect(() => {
    panelTargets.set(id, target);
    setContext("findBarOpen", true);
    return () => {
      panelTargets.delete(id);
      setContext("findBarOpen", panelTargets.size > 0);
      if (focusedTarget === target) {
        focusedTarget = undefined;
        setContext("findBarFocus", false);
        setContext("findBarHasResults", false);
      }
    };
  }, [id, target]);

  useEffect(() => {
    if (focusedTarget === target)
      setContext(
        "findBarHasResults",
        !!target.results && !!opts.search && (!opts.regexp || regexValid(opts.search)) && !!count?.total,
      );
  }, [target, opts, count]);

  // Reserve this bar's shortcut even when there are no results to export.
  useEffect(
    () =>
      registerKeyClaim((e, stroke) => {
        if (
          !panelRef.current?.contains(e.target as Node) ||
          !bindingsFor("find.openInWindow").some((binding) => normalizeBinding(binding) === stroke)
        )
          return false;
        e.preventDefault();
        e.stopPropagation();
        void executeAction("find.openInWindow", id);
        return true;
      }),
    [id],
  );

  // Opening (or ⌘F again): focus + select the field.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [seq]);

  // Push the query into the editor. Like IDEA, only a change of the query (typing, options)
  // selects the nearest match: showing the bar again over its editor leaves the caret alone.
  const shown = useRef<{ target: FindTarget; version: unknown; opts: FindOptions } | null>(null);
  useEffect(() => {
    const view = target.view();
    if (!view) return;
    const prev = shown.current;
    const changed = prev?.target === target && prev.version === version && prev.opts !== opts;
    shown.current = { target, version, opts };
    const valid = !opts.regexp || regexValid(opts.search);
    setQuery(view, valid ? opts : { ...opts, search: "" });
    view.dispatch({ effects: setFindOpen.of(true) });
    if (changed && valid && opts.search && useFindPreferences.getState().scrollToResults) {
      const from = view.state.selection.main.from;
      view.dispatch({ selection: { anchor: from } });
      findNext(view);
    }
    recount(target);
  }, [opts, target, version]);

  // Keep the counter current while the document / selection changes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unwatch = target.watch((u) => {
      if (!u.docChanged && !u.selectionSet) return;
      clearTimeout(timer);
      timer = setTimeout(() => recount(target), u.docChanged ? 150 : 0);
    });
    return () => {
      clearTimeout(timer);
      unwatch();
    };
  }, [target, version]);

  // Closing clears highlights, marks and the selection scope (not React's dev-mode remount).
  useEffect(
    () => () => {
      if (target.isOpen()) return;
      target.view()?.dispatch({ effects: [setFindOpen.of(false)] });
      useFindSessions.setState({ [target.id]: undefined });
      tabTargets.delete(target.id);
    },
    [target],
  );

  const close = () => {
    rememberQuery(id, replace);
    onClose();
  };
  const run = (cmd: (v: EditorView) => boolean) => {
    const view = target.view();
    if (view) cmd(view);
    recount(target);
  };
  const doReplace = () => {
    rememberQuery(id, true);
    run((v) => replaceNext(v, opts.preserveCase));
  };
  const doReplaceAll = () => {
    rememberQuery(id, true);
    run((v) => replaceAll(v, opts.preserveCase));
  };
  const toggle = (key: "caseSensitive" | "wholeWord" | "regexp" | "preserveCase") =>
    updateOptions(id, (o) => ({ [key]: !o[key] }));

  const onKeyDown = (e: KeyboardEvent, field: "find" | "replace") => {
    const input = e.target as HTMLTextAreaElement | HTMLInputElement;
    // Inside a multi-line query the arrows move the caret between its lines.
    const multiLine = input.value.includes("\n");
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setHistoryMenu(field);
    } else if (e.key === "Enter" || e.key === "F3" || (!multiLine && (e.key === "ArrowDown" || e.key === "ArrowUp"))) {
      e.preventDefault();
      const back = e.key === "ArrowUp" || (e.shiftKey && e.key !== "ArrowDown");
      if (field === "replace" && e.key === "Enter" && !e.shiftKey) {
        if (hasPrimaryModifier(e)) doReplaceAll();
        else doReplace();
      } else {
        if (e.key === "Enter") rememberQuery(id, false);
        run(back ? findPrevious : findNext);
      }
    } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const map: Record<string, "caseSensitive" | "wholeWord" | "regexp"> = {
        KeyC: "caseSensitive",
        KeyW: "wholeWord",
        KeyX: "regexp",
      };
      const k = map[e.code];
      if (k) {
        e.preventDefault();
        toggle(k);
      } else if (e.code === "KeyE") {
        e.preventDefault();
        toggleScope(target);
      } else if (replace && e.code === "KeyP") {
        e.preventDefault();
        doReplace();
      } else if (replace && e.code === "KeyA") {
        e.preventDefault();
        doReplaceAll();
      } else if (replace && e.code === "KeyL") {
        e.preventDefault();
        run(excludeCurrent);
      }
    } else if (e.key === "Tab" && !e.shiftKey && field === "find" && replace) {
      e.preventDefault();
      replaceRef.current?.focus();
    }
  };

  const invalid = opts.regexp && !!opts.search && !regexValid(opts.search);
  const none = !!opts.search && !invalid && count?.total === 0;
  const counter = invalid
    ? "Bad regex"
    : !opts.search
      ? ""
      : !count || count.total === 0
        ? "0 results"
        : `${count.current || "?"}/${count.total}${count.capped ? "+" : ""}`;

  const historyItems = (kind: "find" | "replace"): MenuItem[] => {
    const h = searchHistory(kind);
    return h.length
      ? [
          { kind: "header", label: kind === "find" ? "Recent Searches" : "Recent Replacements" },
          ...h.map((q) => ({
            label: q.replace(/\n/g, "⏎"),
            verbatim: true,
            run: () => setOpts(kind === "find" ? { search: q } : { replace: q }),
          })),
        ]
      : [{ label: kind === "find" ? "No recent searches" : "No recent replacements", disabled: true }];
  };
  const filterItems: MenuItem[] = [
    {
      label: "Search In Selection",
      shortcut: formatBinding("Alt+E"),
      checked: scoped || undefined,
      run: () => toggleScope(target),
    },
    { kind: "separator" },
    { kind: "header", label: "Search Scope" },
    ...SEARCH_CONTEXTS.map((c) => ({
      label: c.label,
      checked: c.value === opts.context ? true : undefined,
      run: () => setOpts({ context: c.value }),
    })),
  ];
  const invoke = (action: string) => void executeAction(action, id);
  const moreItems: MenuItem[] = [
    {
      label: "Open Results in Find Window",
      shortcut: shortcutLabel("find.openInWindow"),
      disabled: !target.results || !opts.search || invalid || !count?.total,
      run: () => invoke("find.openInWindow"),
    },
    { kind: "separator" },
    { kind: "header", label: "Multiple Cursors" },
    ...(
      [
        ["code.addCaretNextOccurrence", "Add Selection for Next Occurrence"],
        ["code.unselectOccurrence", "Unselect Occurrence"],
        ["code.selectAllOccurrences", "Select All Occurrences"],
      ] as const
    ).map(([action, label]) => ({ label, shortcut: shortcutLabel(action), run: () => invoke(action) })),
    { kind: "separator" },
    { label: "Scroll to Results During Typing", checked: scrollToResults, run: () => invoke("find.scrollToResults") },
  ];
  const canReplace = !!opts.search && !invalid;

  return (
    <div
      ref={panelRef}
      onFocusCapture={() => {
        focusedTarget = target;
        setContext("findBarFocus", true);
        setContext(
          "findBarHasResults",
          !!target.results && !!opts.search && (!opts.regexp || regexValid(opts.search)) && !!count?.total,
        );
      }}
      onBlurCapture={(e) => {
        if (!panelRef.current?.contains(e.relatedTarget as Node | null)) setContext("findBarFocus", false);
      }}
      className={clsx(styles.find, onReplaceShown && styles.findExpandable)}
      role="search"
      aria-label={replace ? "Replace in file" : "Find in file"}
    >
      {onReplaceShown && (
        <IconButton
          icon={replace ? "chevron-down" : "chevron-right"}
          title={replace ? "Hide Replace" : "Show Replace"}
          size="small"
          className={styles.findExpand}
          aria-expanded={replace}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (replaceBoxRef.current?.contains(document.activeElement)) inputRef.current?.focus();
            onReplaceShown(!replace);
          }}
        />
      )}
      <div ref={findBoxRef} className={styles.findField}>
        <SearchField
          ref={inputRef}
          value={opts.search}
          onChange={(search) => setOpts({ search })}
          placeholder="Find"
          aria-label="Find"
          invalid={invalid || none}
          multiline
          onHistory={() => setHistoryMenu("find")}
          onKeyDown={(e) => onKeyDown(e, "find")}
          toggles={[
            {
              id: "case",
              icon: "case",
              title: "Match Case",
              shortcut: formatBinding("Alt+C"),
              pressed: opts.caseSensitive,
              onToggle: () => toggle("caseSensitive"),
            },
            {
              id: "word",
              icon: "word",
              title: "Words",
              shortcut: formatBinding("Alt+W"),
              pressed: opts.wholeWord,
              onToggle: () => toggle("wholeWord"),
            },
            {
              id: "regex",
              icon: "regex",
              title: "Regex",
              shortcut: formatBinding("Alt+X"),
              pressed: opts.regexp,
              onToggle: () => toggle("regexp"),
            },
          ]}
        />
      </div>
      <div className={styles.findButtons}>
        <span className={clsx(styles.findCount, (none || invalid) && styles.findCountNone)} aria-live="polite">
          {counter}
        </span>
        <IconButton
          icon="arrow-up"
          title="Previous Occurrence"
          shortcut={formatBinding("Shift+Enter")}
          size="small"
          onClick={() => run(findPrevious)}
        />
        <IconButton
          icon="arrow-down"
          title="Next Occurrence"
          shortcut={formatBinding("Enter")}
          size="small"
          onClick={() => run(findNext)}
        />
        <IconButton
          ref={filterRef}
          icon="filter"
          title="Filter Search Results"
          size="small"
          pressed={scoped || opts.context !== "any"}
          onClick={() => setFilterMenu(true)}
        />
        <IconButton ref={moreRef} icon="more" title="More" size="small" onClick={() => setMoreMenu(true)} />
      </div>
      <IconButton icon="close" title="Close" shortcut="⎋" size="small" className={styles.findClose} onClick={close} />
      {replace && (
        <>
          <div ref={replaceBoxRef} className={styles.findField}>
            <SearchField
              ref={replaceRef}
              value={opts.replace}
              onChange={(value) => setOpts({ replace: value })}
              placeholder="Replace"
              aria-label="Replace"
              multiline
              onHistory={() => setHistoryMenu("replace")}
              onKeyDown={(e) => onKeyDown(e, "replace")}
              toggles={[
                {
                  id: "preserveCase",
                  icon: "preserve-case",
                  title: "Preserve Case",
                  pressed: opts.preserveCase,
                  onToggle: () => toggle("preserveCase"),
                },
              ]}
            />
          </div>
          <div className={styles.replaceButtons}>
            <Button
              size="small"
              title={tx`Replace (${formatBinding("Alt+P")})`}
              onClick={doReplace}
              disabled={!canReplace}
            >
              <T>Replace</T>
            </Button>
            <Button
              size="small"
              title={tx`Replace All (${formatBinding("Alt+A")})`}
              onClick={doReplaceAll}
              disabled={!canReplace}
            >
              <T>Replace All</T>
            </Button>
            <Button
              size="small"
              title={
                count?.excluded ? tx`Include (${formatBinding("Alt+L")})` : tx`Exclude (${formatBinding("Alt+L")})`
              }
              onClick={() => run(excludeCurrent)}
              disabled={!canReplace || (!count?.total && !count?.excluded)}
            >
              {count?.excluded ? <T>Include</T> : <T>Exclude</T>}
            </Button>
          </div>
        </>
      )}
      <Menu
        open={historyMenu !== null}
        anchor={historyMenu === "replace" ? replaceBoxRef : findBoxRef}
        items={historyMenu ? historyItems(historyMenu) : []}
        placement="bottom-start"
        aria-label="Recent searches"
        onClose={() => setHistoryMenu(null)}
      />
      <Menu
        open={moreMenu}
        anchor={moreRef}
        items={moreItems}
        placement="bottom-end"
        aria-label="Find options"
        onClose={() => setMoreMenu(false)}
      />
      <Menu
        open={filterMenu}
        anchor={filterRef}
        items={filterItems}
        placement="bottom-end"
        aria-label="Filter search results"
        onClose={() => setFilterMenu(false)}
      />
    </div>
  );
}
