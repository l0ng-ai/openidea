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
import { hasPrimaryModifier } from "@/platform/keymap";

/** The query is shared by all panes and survives closing the bar, like IDEA. */
export const useFindOptions = create<Required<FindOptions>>(() => ({
  search: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  replace: "",
  context: "any",
  preserveCase: false,
}));
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
}

function activeView(paneId: string): EditorView | null {
  const pane = useTabs.getState().panes[paneId];
  if (!pane?.active) return null;
  return editorController().slotFor(pane.active)?.view ?? null;
}

const paneTargets = new Map<string, FindTarget>();

function paneTarget(paneId: string): FindTarget {
  let target = paneTargets.get(paneId);
  if (!target) {
    target = {
      id: paneId,
      view: () => activeView(paneId),
      watch(fn) {
        const tab = useTabs.getState().panes[paneId]?.active;
        const slot = tab ? editorController().slotFor(tab) : null;
        if (!slot) return () => {};
        slot.listeners.add(fn);
        return () => void slot.listeners.delete(fn);
      },
      isOpen: () => !!useFindBars.getState()[paneId],
    };
    paneTargets.set(paneId, target);
  }
  return target;
}

export function closeFindBar(paneId: string) {
  useFindBars.setState({ [paneId]: undefined });
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
  seedFind(paneTarget(paneId), replace);
  useFindBars.setState((s) => ({ [paneId]: { replace, seq: (s[paneId]?.seq ?? 0) + 1 } }));
}

/** The query and scope a bar opening over `target`'s selection starts with (see openFindBar). */
export function seedFind(target: FindTarget, replace: boolean) {
  const view = target.view();
  const sel = view?.state.selection.main;
  if (view && sel && !sel.empty) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    const multiline = text.includes("\n");
    openSelections.set(target.id, { from: sel.from, to: sel.to });
    if (multiline && replace) {
      view.dispatch({ effects: setFindScope.of({ from: sel.from, to: sel.to }) });
      useFindOptions.setState({ search: "" });
    } else {
      view.dispatch({ effects: setFindScope.of(null) });
      if (text.length < MAX_QUERY)
        useFindOptions.setState((o) => ({ search: o.regexp ? text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : text }));
    }
  } else if (useFindOptions.getState().search.includes("\n")) {
    useFindOptions.setState({ search: "" });
  }
}

/** Show / Hide Replace on the open bar, keeping its query and scope. */
function setReplaceShown(paneId: string, replace: boolean) {
  useFindBars.setState((s) => ({ [paneId]: { replace, seq: s[paneId]?.seq ?? 0 } }));
}

/** ⌘G / ⇧⌘G: next / previous occurrence of the last search, with or without the bar. */
export function findAgain(paneId: string, forward: boolean) {
  const target = paneTarget(paneId);
  const view = target.view();
  if (!view) return;
  if (!searchAgain(target, forward)) openFindBar(paneId, false);
}

/** Next / previous occurrence of the last search in `target`; false without a usable query. */
export function searchAgain(target: FindTarget, forward: boolean): boolean {
  const view = target.view();
  const opts = useFindOptions.getState();
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
  const opts = useFindOptions.getState();
  const r = countMatches(view.state);
  const { from, to } = view.state.selection.main;
  useFindCounts.setState({ [target.id]: opts.search ? { ...r, excluded: isExcluded(view.state, from, to) } : null });
  useFindScoped.setState({ [target.id]: !!view.state.field(findScope, false) });
  view.dispatch({ effects: setFindMarks.of(opts.search ? r.starts : []) });
}

function rememberQuery(replace: boolean) {
  const o = useFindOptions.getState();
  rememberSearch("find", o.search);
  if (replace) rememberSearch("replace", o.replace);
}

export function FindBar({ paneId }: { paneId: string }) {
  const bar = useFindBars((s) => s[paneId]);
  const activeTab = useTabs((s) => s.panes[paneId]?.active ?? null);
  if (!bar) return null;
  return (
    <FindPanel
      target={paneTarget(paneId)}
      version={activeTab}
      replace={bar.replace}
      seq={bar.seq}
      onReplaceShown={(replace) => setReplaceShown(paneId, replace)}
      onClose={() => {
        closeFindBar(paneId);
        activeView(paneId)?.focus();
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
  const opts = useFindOptions();
  const count = useFindCounts((s) => s[id] ?? null);
  const scoped = useFindScoped((s) => !!s[id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const findBoxRef = useRef<HTMLDivElement>(null);
  const replaceBoxRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const [historyMenu, setHistoryMenu] = useState<"find" | "replace" | null>(null);
  const [filterMenu, setFilterMenu] = useState(false);
  const setOpts = (patch: Partial<FindOptions>) => useFindOptions.setState(patch);

  // Opening (or ⌘F again): focus + select the field.
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [seq]);

  // Push the query into the editor; incremental search selects the nearest match.
  useEffect(() => {
    const view = target.view();
    if (!view) return;
    const valid = !opts.regexp || regexValid(opts.search);
    setQuery(view, valid ? opts : { ...opts, search: "" });
    view.dispatch({ effects: setFindOpen.of(true) });
    if (valid && opts.search) {
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
      if (!target.isOpen()) target.view()?.dispatch({ effects: [setFindOpen.of(false)] });
    },
    [target],
  );

  const close = () => {
    rememberQuery(replace);
    onClose();
  };
  const run = (cmd: (v: EditorView) => boolean) => {
    const view = target.view();
    if (view) cmd(view);
    recount(target);
  };
  const doReplace = () => {
    rememberQuery(true);
    run((v) => replaceNext(v, opts.preserveCase));
  };
  const doReplaceAll = () => {
    rememberQuery(true);
    run((v) => replaceAll(v, opts.preserveCase));
  };
  const toggle = (key: "caseSensitive" | "wholeWord" | "regexp" | "preserveCase") =>
    useFindOptions.setState((o) => ({ [key]: !o[key] }));

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
        if (e.key === "Enter") rememberQuery(false);
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
    { label: "Search In Selection", shortcut: "⌥E", checked: scoped || undefined, run: () => toggleScope(target) },
    { kind: "separator" },
    { kind: "header", label: "Search Scope" },
    ...SEARCH_CONTEXTS.map((c) => ({
      label: c.label,
      checked: c.value === opts.context ? true : undefined,
      run: () => setOpts({ context: c.value }),
    })),
  ];
  const canReplace = !!opts.search && !invalid;

  return (
    <div className={styles.find} role="search" aria-label={replace ? "Replace in file" : "Find in file"}>
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
              shortcut: "⌥C",
              pressed: opts.caseSensitive,
              onToggle: () => toggle("caseSensitive"),
            },
            {
              id: "word",
              icon: "word",
              title: "Words",
              shortcut: "⌥W",
              pressed: opts.wholeWord,
              onToggle: () => toggle("wholeWord"),
            },
            {
              id: "regex",
              icon: "regex",
              title: "Regex",
              shortcut: "⌥X",
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
          shortcut="⇧↵"
          size="small"
          onClick={() => run(findPrevious)}
        />
        <IconButton icon="arrow-down" title="Next Occurrence" shortcut="↵" size="small" onClick={() => run(findNext)} />
        <IconButton
          ref={filterRef}
          icon="filter"
          title="Filter Search Results"
          size="small"
          pressed={scoped || opts.context !== "any"}
          onClick={() => setFilterMenu(true)}
        />
        {onReplaceShown && (
          <IconButton
            icon="replace"
            title={replace ? "Hide Replace" : "Show Replace"}
            size="small"
            pressed={replace}
            onClick={() => onReplaceShown(!replace)}
          />
        )}
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
            <Button size="small" title="Replace (⌥P)" onClick={doReplace} disabled={!canReplace}>
              <T>Replace</T>
            </Button>
            <Button size="small" title="Replace All (⌥A)" onClick={doReplaceAll} disabled={!canReplace}>
              <T>Replace All</T>
            </Button>
            <Button
              size="small"
              title={count?.excluded ? "Include (⌥L)" : "Exclude (⌥L)"}
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
