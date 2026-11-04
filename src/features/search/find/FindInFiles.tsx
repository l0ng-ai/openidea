import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { openEditorPaths, useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { t, useTxTemplate, tx } from "@/platform/i18n";
import { formatBinding, hostBinding, shortcutLabel } from "@/platform/keymap";
import { call, commands, isTauri, type SearchScope } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useProjectModules } from "@/platform/projectRoots";
import { EDIT_SCOPES_ACTION, useCustomScopeList } from "@/platform/search";
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  List,
  Menu,
  SearchField,
  Select,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  listNavigate,
  type MenuItem,
  T,
} from "@/ui";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { basename, dirname, openLocation } from "../common/open";
import { CodePreview, MatchText, ReplaceDiffPreview } from "./parts";
import { clearPreviewCache } from "./preview";
import {
  NO_MARKS,
  confirmText,
  countUsages,
  groupState,
  loadReplacePreview,
  markDone,
  nextPending,
  pendingUsages,
  replacePreviewLines,
  replaceTargets,
  startReplace,
  summaryText,
  type PreviewLine,
  type ReplaceMarks,
  type ReplaceProgress,
  type ReplaceRun,
  type Usage,
} from "./replaceFlow";
import { SINGLE_FIRST, isRowSelected, selectRow, selectedRows, type RowSelection } from "./rowSelection";
import { FindSession, IDLE, matchRows, type FindState, type MatchRow } from "./session";
import {
  SEARCH_CONTEXTS,
  buildQuery,
  customScopeName,
  customScopeValue,
  describeQuery,
  findHistory,
  hideFindPopup,
  recentMasks,
  rememberFindString,
  refreshProjectMasks,
  rememberMask,
  resolveDirectory,
  resolveFindScope,
  setFindPopupCommandHandler,
  loadFindPopupSize,
  loadFindPopupSplit,
  saveFindPopupSize,
  saveFindPopupSplit,
  setFindPopupNewTab,
  setFindPopupPinned,
  useFindPopup,
  useProjectMasks,
  type FindOptions,
  type BuiltinScope,
  type FindPopupCommand,
  type NamedScope,
  type ScopeTab,
} from "./store";
import { ipcFindDeps, openInFindWindow } from "./windowStore";
import styles from "./FindInFiles.module.css";

/** The Directory scope's browse button: a folder chooser opened at the current directory. */
async function chooseDirectory(current: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    multiple: false,
    title: tx("Select Search Directory"),
    defaultPath: current || undefined,
  });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

const POPUP_MAX_MATCHES = 2000;
const SEARCH_DEBOUNCE_MS = 150;
const ROW = 24;

export function FindInFilesOverlay() {
  const open = useFindPopup((s) => s.open);
  return open ? <FindInFilesDialog /> : null;
}

const SCOPE_TABS: Array<{ id: ScopeTab; label: string }> = [
  { id: "project", label: "In Project" },
  { id: "module", label: "Module" },
  { id: "directory", label: "Directory" },
  { id: "scope", label: "Scope" },
];

const NAMED_SCOPES: Array<{ value: BuiltinScope; label: string }> = [
  { value: "projectFiles", label: "Project Files" },
  { value: "productionFiles", label: "Project Production Files" },
  { value: "testFiles", label: "Project Test Files" },
  { value: "openFiles", label: "Open Files" },
  { value: "recentFiles", label: "Recently Viewed Files" },
];

function displayDirectory(dir: string, root: string | null): string {
  if (root && dir === root) return "";
  return root && dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
}

function FindInFilesDialog() {
  const s = useFindPopup();
  const txt = useTxTemplate();
  const project = useProject((p) => p.project);
  const root = project?.workspace?.projects[0] ?? (project?.workspace ? null : (project?.root ?? null));
  const workspace = useProject((p) => !!p.project?.workspace);
  const editors = useEditorRegistry((r) => r.editors);
  const modules = useProjectModules();
  const customScopes = useCustomScopeList();
  const [state, setState] = useState<FindState>(IDLE);
  const [session] = useState(() => new FindSession(ipcFindDeps(), setState));
  const [sel, setSel] = useState<RowSelection>(SINGLE_FIRST);
  const setIndex = (i: number) => setSel({ lead: i, anchor: i, keys: null });
  const [recentPaths, setRecentPaths] = useState<string[] | null>(null);
  const [maskMenu, setMaskMenu] = useState(false);
  const [historyMenu, setHistoryMenu] = useState<"find" | "replace" | null>(null);
  const [contextMenu, setContextMenu] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  // OpenIDEA's Replace › Preview: the preview shows the replacement as a diff.
  const [previewMode, setPreviewMode] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ key: string; lines: PreviewLine[] } | null>(null);
  const [initialSize] = useState(loadFindPopupSize);
  const [split, setSplit] = useState(loadFindPopupSplit);
  const keepSplit = (layout: Record<string, number>) => {
    setSplit(layout);
    saveFindPopupSplit(layout);
  };
  const [marks, setMarks] = useState<ReplaceMarks>(NO_MARKS);
  const [running, setRunning] = useState<ReplaceRun | null>(null);
  const [progress, setProgress] = useState<ReplaceProgress | null>(null);
  const busy = !!running;
  const patternRef = useRef<HTMLInputElement>(null);
  const patternBoxRef = useRef<HTMLDivElement>(null);
  const replaceBoxRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLDivElement>(null);
  const maskInputRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<FindOptions>) => useFindPopup.setState(patch);

  useEffect(() => () => session.dispose(), [session]);
  const projectMasks = useProjectMasks((p) => p.masks);
  useEffect(() => void refreshProjectMasks(), []);
  /** Turning the mask on with nothing typed takes the first suggestion, as IDEA's combo box shows one. */
  const enableMask = (on: boolean) =>
    set(on && !s.mask.trim() ? { maskEnabled: true, mask: recentMasks()[0] ?? "" } : { maskEnabled: on });
  useEffect(() => {
    if (modules.length && !modules.some((m) => m.path === s.module))
      useFindPopup.setState({ module: modules[0]!.path });
  }, [modules, s.module]);

  // Hidden popup actions (⌘G, F4, ⌥↓ …) win over the editor's bindings while this is set.
  useEffect(() => {
    setContext("findPopupOpen", true);
    return () => setContext("findPopupOpen", false);
  }, []);

  useEffect(() => {
    patternRef.current?.select();
  }, [s.session]);

  useEffect(() => {
    if (s.scopeTab !== "scope" || s.namedScope !== "recentFiles" || recentPaths) return;
    call(commands.recentFiles()).then(
      (p) => setRecentPaths(p.map(String)),
      () => setRecentPaths([]),
    );
  }, [s.scopeTab, s.namedScope, recentPaths]);

  const scope: SearchScope = useMemo(
    () =>
      resolveFindScope(s, {
        root,
        // Every open tab, not just the visible editors; `editors` only re-triggers this memo.
        openPaths: () => [...new Set([...openEditorPaths(), ...[...editors].map((e) => e.ctx.path)])],
        recentPaths,
      }),
    // `customScopes`: an edited scope pattern re-runs the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.scopeTab, s.module, s.directory, s.namedScope, root, editors, recentPaths, customScopes],
  );

  const options: FindOptions = {
    pattern: s.pattern,
    replacement: s.replacement,
    caseSensitive: s.caseSensitive,
    wholeWord: s.wholeWord,
    isRegex: s.isRegex,
    preserveCase: s.preserveCase,
    maskEnabled: s.maskEnabled,
    mask: s.mask,
    scopeTab: s.scopeTab,
    module: s.module,
    directory: s.directory,
    namedScope: s.namedScope,
    context: s.context,
  };
  const query = useMemo(
    () => buildQuery(options, scope, POPUP_MAX_MATCHES),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.pattern, s.caseSensitive, s.wholeWord, s.isRegex, s.maskEnabled, s.mask, s.context, scope],
  );
  const queryKey = JSON.stringify(query);

  const stale = state.stale || (state.query ? JSON.stringify(state.query) !== queryKey : !!s.pattern);
  const currentQuery = useRef(queryKey);
  const [rerun, setRerun] = useState(0);
  useLayoutEffect(() => {
    currentQuery.current = queryKey;
    session.invalidate();
    const t = setTimeout(() => {
      void session.search(query);
      setIndex(0);
      setMarks(NO_MARKS);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, queryKey, rerun]);

  const rows = useMemo(() => matchRows(state.files), [state.files]);
  const active = rows.length ? Math.min(sel.lead, rows.length - 1) : -1;
  const selected = active >= 0 ? rows[active] : undefined;
  const chosen = useMemo(() => selectedRows(rows, sel), [rows, sel]);
  const fileHighlights = useMemo(() => {
    if (stale || !selected) return [];
    const f = state.files.find((x) => x.path === selected.path);
    return (f?.matches ?? []).map((m) => ({
      line: m.line,
      ranges: m.ranges.map(([a, b]) => [a + m.textOffset, b + m.textOffset] as [number, number]),
    }));
  }, [stale, selected, state.files]);

  const close = () => {
    rememberFindString("find", s.pattern);
    if (s.replace) rememberFindString("replace", s.replacement);
    clearPreviewCache();
    hideFindPopup();
  };
  /** Opens a result; a pinned popup stays open (IDEA's pin). */
  const openRow = (row: MatchRow | undefined, side = false) => {
    if (!row) return;
    const pos = { line: row.line, col: row.col, endLine: row.line, endCol: row.endCol };
    if (s.pinned) {
      rememberFindString("find", s.pattern);
      void openLocation(row.path, pos, { side, focus: false });
      return;
    }
    close();
    setTimeout(() => void openLocation(row.path, pos, { side }), 0);
  };
  const pin = () => {
    if (!s.pattern) return;
    if (s.maskEnabled) rememberMask(s.mask);
    const pinned = buildQuery(options, scope, 0);
    close();
    openInFindWindow(pinned, describeQuery(pinned, root), {
      replacement: s.replace ? s.replacement : null,
      preserveCase: s.preserveCase,
      newTab: s.newTab,
    });
  };

  // Check again after a confirmation: its captured rows may have been superseded.
  const canReplace = () =>
    !stale && !session.current.stale && currentQuery.current === queryKey && session.current.files === state.files;

  /** IDEA asks before Replace All only when the results span more than one file. */
  const confirmReplaceAll = async () => {
    if (!canReplace()) return;
    const usages = pendingUsages(rows, marks);
    if (!usages.length) return;
    const counts = countUsages(usages);
    if (rows.length <= 1 || counts.files <= 1) {
      void replaceAll(usages);
      return;
    }
    const ok = await confirm({
      title: "Replace All",
      ok: "Replace",
      message: (
        <>
          {confirmText(counts, s.pattern, s.replacement || "")}
          {marks.excluded.size > 0 && (
            <>
              {" "}
              <T>Excluded usages are skipped.</T>
            </>
          )}
          {state.summary?.limitHit && (
            <>
              {"\n"}
              <T>The search hit its limit; only usages found so far are replaced.</T>
            </>
          )}
        </>
      ),
    });
    if (ok) void replaceAll(usages);
  };

  /** Replaces `usages` in the backend, then marks them done (IDEA's Replace / Replace All). */
  const replaceUsages = async (usages: Usage[]): Promise<ReplaceMarks | null> => {
    if (!canReplace() || !usages.length || running) return null;
    const run = startReplace(
      { query, replacement: s.replacement, preserveCase: s.preserveCase, targets: replaceTargets(usages) },
      setProgress,
    );
    setRunning(run);
    try {
      const summary = await run.result;
      notifications().notify({
        group: "search",
        level: summary.failed ? "warning" : "info",
        title: summaryText(summary),
        body: summary.files === 1 ? basename(usages[0]!.path) : undefined,
        key: "search.replace",
      });
      clearPreviewCache();
      setPreviewVersion((v) => v + 1);
      // Replacements that add or remove lines (or a stopped run) invalidate the positions found.
      if (summary.cancelled || /\n|\\n/.test(s.replacement)) {
        setRerun((r) => r + 1);
        return null;
      }
      const next = markDone(marks, usages);
      setMarks(next);
      return next;
    } catch (e) {
      notifications().notify({
        group: "search",
        level: "error",
        title: "Replace failed",
        body: String((e as Error)?.message ?? e),
      });
      return null;
    } finally {
      setRunning(null);
      setProgress(null);
    }
  };

  /** Replace Selected (↵ in Replace mode): every selected row, then the next row to replace. */
  const replaceSelected = async () => {
    if (!chosen.length) return;
    const last = rows.indexOf(chosen[chosen.length - 1]!);
    const next = await replaceUsages(pendingUsages(chosen, marks));
    if (next) {
      const i = nextPending(rows, last, next);
      if (i >= 0) setIndex(i);
    }
  };
  const replaceAll = async (usages: Usage[]) => {
    const done = await replaceUsages(usages);
    if (done) close();
  };

  const diffPreviewKey = JSON.stringify([
    selected?.key,
    queryKey,
    s.replacement,
    s.preserveCase,
    rerun,
    previewVersion,
  ]);
  useEffect(() => {
    if (stale || !previewMode || !s.replace || !selected) return;
    let alive = true;
    const key = diffPreviewKey;
    const usages = pendingUsages([selected], marks);
    const t = setTimeout(() => {
      loadReplacePreview(query, s.replacement, s.preserveCase, selected.path, usages).then(
        (p) => alive && setDiffPreview({ key, lines: replacePreviewLines(p.before, p.edits) }),
        () => alive && setDiffPreview(null),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, previewMode, s.replace, diffPreviewKey, marks]);

  const moveTo = (next: number, extend: boolean) =>
    setSel((cur) => selectRow(rows, cur, next, extend ? "range" : "single"));
  const onRowClick = (index: number, e: MouseEvent) => {
    const mode = e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "single";
    setSel((cur) => selectRow(rows, cur, index, mode));
  };

  const toggleMnemonic = (code: string): boolean => {
    const toggle = { KeyC: "caseSensitive", KeyW: "wholeWord", KeyX: "isRegex" }[code] as
      | "caseSensitive"
      | "wholeWord"
      | "isRegex"
      | undefined;
    if (toggle) set({ [toggle]: !s[toggle] });
    else if (code === "KeyK") {
      enableMask(!s.maskEnabled);
      if (!s.maskEnabled) setTimeout(() => maskInputRef.current?.select(), 0);
    } else if (code === "KeyE" && s.replace) set({ preserveCase: !s.preserveCase });
    else if (code === "KeyB") setFindPopupNewTab(!s.newTab);
    else if (code === "KeyA" && s.replace) {
      if (rows.length && !busy) void confirmReplaceAll();
    } else return false;
    return true;
  };

  /** IDEA's "Clear all options" (⇧⌥⌫): back to a plain search everywhere. */
  const clearOptions = () =>
    set({ caseSensitive: false, wholeWord: false, isRegex: false, maskEnabled: false, context: "any" });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inField =
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && target.closest("[data-find-field]");
    if (e.key === "Backspace" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      clearOptions();
      return;
    }
    if (e.key === "Enter" && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // ⇧⌥↵: Replace All.
      e.preventDefault();
      if (s.replace && rows.length && !busy) void confirmReplaceAll();
      return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && toggleMnemonic(e.code)) {
      e.preventDefault();
      return;
    }
    if (!inField) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) pin();
      else if (s.replace && !e.shiftKey) {
        if (!busy) void replaceSelected();
      } else openRow(selected, e.shiftKey);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key) || e.altKey) return;
    // Inside a multi-line query the arrows move the caret between its lines.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && (target as HTMLTextAreaElement).value?.includes("\n")) return;
    const next = listNavigate(e.key, { items: rows, active, pageSize: 9 });
    if (next === null) return;
    e.preventDefault();
    moveTo(next, e.shiftKey);
  };

  // Keys that are global shortcuts too arrive through hidden actions (see store).
  const commandRef = useRef<(c: FindPopupCommand) => void>(() => {});
  useLayoutEffect(() => {
    commandRef.current = (c) => {
      if (c === "nextResult" || c === "previousResult") {
        if (!rows.length) return;
        const step = c === "nextResult" ? 1 : -1;
        moveTo((active + step + rows.length) % rows.length, false);
      } else if (c === "openResult") openRow(selected);
      else {
        const el = document.activeElement;
        setHistoryMenu(replaceBoxRef.current?.contains(el) ? "replace" : "find");
      }
    };
  });
  useEffect(() => {
    setFindPopupCommandHandler((c) => commandRef.current(c));
    return () => setFindPopupCommandHandler(null);
  }, []);

  const summary = stale ? (s.pattern ? tx("Updating results…") : "") : statusText(state);
  const maskItems: MenuItem[] = recentMasks().map((m) => ({
    label: m,
    checked: m === s.mask ? true : undefined,
    run: () => set({ mask: m, maskEnabled: true }),
  }));
  const historyItems = (kind: "find" | "replace"): MenuItem[] => {
    const h = findHistory(kind);
    return h.length
      ? [
          { kind: "header", label: kind === "find" ? "Recent Searches" : "Recent Replacements" },
          ...h.map((q) => ({
            label: q,
            verbatim: true,
            run: () => set(kind === "find" ? { pattern: q } : { replacement: q }),
          })),
        ]
      : [{ label: kind === "find" ? "No recent searches" : "No recent replacements", disabled: true }];
  };
  const contextItems: MenuItem[] = SEARCH_CONTEXTS.map((c) => ({
    label: c.label,
    checked: c.value === s.context ? true : undefined,
    run: () => set({ context: c.value }),
  }));
  const pendingSelected = s.replace && !stale ? pendingUsages(chosen, marks).length : 0;
  // A multi-line query takes the arrow keys, so IDEA names the keys that still move through results.
  const nextKey = shortcutLabel("find.popup.nextResult");
  const previousKey = shortcutLabel("find.popup.previousResult");
  const navigationHint =
    s.pattern.includes("\n") && nextKey && previousKey ? tx`Use ${nextKey} and ${previousKey} to select usages` : "";

  const resultsBox = (
    <div
      className={clsx(styles.results, stale && styles.outdated)}
      data-stale={stale || undefined}
      aria-busy={stale || state.status === "searching"}
    >
      <List<MatchRow>
        items={rows}
        getKey={(r, i) => `${r.key}:${i}`}
        activeIndex={active}
        isSelected={(r) => isRowSelected(sel, r.key)}
        onActivate={(r, i, e) => {
          if (e.type === "click" && (e as MouseEvent).detail < 2) return onRowClick(i, e as MouseEvent);
          openRow(r, e.shiftKey);
        }}
        focusable={false}
        rowHeight={ROW}
        aria-label="Matches"
        empty={
          <EmptyResults state={state} options={options} onClear={clearOptions} onRegex={() => set({ isRegex: true })} />
        }
        renderItem={(r, st) => {
          const state = s.replace ? groupState(r, marks) : "pending";
          return (
            <>
              <span
                className={clsx(
                  styles.rowText,
                  state === "done" && styles.rowDone,
                  state === "excluded" && styles.rowExcluded,
                )}
              >
                <MatchText
                  text={r.text}
                  ranges={stale ? [] : r.ranges}
                  source={{ path: r.path, line: r.line, col: r.textCol }}
                />
              </span>
              <span className={clsx(styles.rowFile, st.active && styles.rowFileActive)}>
                {state === "done" && (
                  <span className={styles.rowLine}>
                    <T>replaced ·</T>{" "}
                  </span>
                )}
                {workspace ? r.relPath : basename(r.relPath)} <span className={styles.rowLine}>{r.line + 1}</span>
              </span>
            </>
          );
        }}
      />
    </div>
  );

  return (
    <Dialog
      open
      onClose={close}
      width={820}
      resizable="both"
      minWidth={560}
      minHeight={400}
      initialSize={initialSize}
      onResized={saveFindPopupSize}
      position="top"
      transparentBackdrop
      // IDEA's Find in Files is a modeless dialog: it survives switching to another app.
      closeOnDeactivate={false}
      dismissOnBackdrop={!s.pinned}
      aria-label={s.replace ? "Replace in Files" : "Find in Files"}
      className={styles.dialog}
    >
      <div className={styles.root} onKeyDown={onKeyDown}>
        <header className={styles.header} data-dialog-drag="">
          <span className={styles.title}>{s.replace ? tx("Replace in Files") : tx("Find in Files")}</span>
          <span className={styles.status} aria-live="polite">
            {stale || state.status === "searching" || state.status === "validating" ? <Spinner size={12} /> : null}
            {summary}
          </span>
          <span className={styles.spacer} />
          <Checkbox checked={s.maskEnabled} onChange={enableMask} label="File mask:" />
          <div ref={maskRef} className={clsx(styles.mask, !s.maskEnabled && styles.maskOff)}>
            <input
              ref={maskInputRef}
              className={styles.maskInput}
              value={s.mask}
              placeholder={projectMasks[0] ?? ""}
              aria-label={tx("File mask")}
              spellCheck={false}
              onChange={(e) => set({ mask: e.target.value, maskEnabled: true })}
              onBlur={() => s.maskEnabled && rememberMask(s.mask)}
            />
            <IconButton
              icon="chevron-down"
              title="Recent file masks"
              size="small"
              iconSize={11}
              onClick={() => setMaskMenu(true)}
            />
          </div>
          <IconButton
            ref={contextRef}
            icon="filter"
            title="Search Context"
            pressed={s.context !== "any"}
            onClick={() => setContextMenu(true)}
          />
          <IconButton icon="pin" title="Pin Window" pressed={s.pinned} onClick={() => setFindPopupPinned(!s.pinned)} />
        </header>
        <div className={styles.fields}>
          <div data-find-field ref={patternBoxRef}>
            <SearchField
              ref={patternRef}
              data-autofocus
              value={s.pattern}
              onChange={(v) => set({ pattern: v })}
              placeholder={s.isRegex ? "Regular expression" : "Text to find"}
              aria-label="Text to find"
              invalid={state.status === "invalid"}
              className={styles.field}
              multiline
              onHistory={() => setHistoryMenu("find")}
              toggles={[
                {
                  id: "case",
                  icon: "case",
                  title: "Match Case",
                  shortcut: formatBinding("Alt+C"),
                  pressed: s.caseSensitive,
                  onToggle: (v) => set({ caseSensitive: v }),
                },
                {
                  id: "word",
                  icon: "word",
                  title: "Words",
                  shortcut: formatBinding("Alt+W"),
                  pressed: s.wholeWord,
                  onToggle: (v) => set({ wholeWord: v }),
                },
                {
                  id: "regex",
                  icon: "regex",
                  title: "Regex",
                  shortcut: formatBinding("Alt+X"),
                  pressed: s.isRegex,
                  onToggle: (v) => set({ isRegex: v }),
                },
              ]}
            />
          </div>
          {state.status === "invalid" && state.error && <div className={styles.error}>{state.error}</div>}
          {s.replace && (
            <div data-find-field ref={replaceBoxRef}>
              <SearchField
                value={s.replacement}
                onChange={(v) => set({ replacement: v })}
                leadingIcon="replace"
                placeholder="Replace with"
                aria-label="Replace with"
                className={styles.field}
                multiline
                onHistory={() => setHistoryMenu("replace")}
                toggles={[
                  {
                    id: "preserveCase",
                    icon: "preserve-case",
                    title: "Preserve Case",
                    shortcut: formatBinding("Alt+E"),
                    pressed: s.preserveCase,
                    onToggle: (v) => set({ preserveCase: v }),
                  },
                ]}
              />
            </div>
          )}
        </div>
        <div className={styles.scopeRow}>
          <Tabs
            variant="compact"
            aria-label="Search scope"
            items={SCOPE_TABS.map((t) => ({ id: t.id, label: t.label }))}
            activeId={s.scopeTab}
            onSelect={(id) => {
              // IDEA starts the Directory scope at the current file's folder.
              if (id === "directory" && !s.directory.trim()) {
                const active = maybeEditorService()?.activePath();
                const folders = project?.workspace?.projects ?? (root ? [root] : []);
                const dir = active && folders.some((r) => active.startsWith(r + "/")) ? dirname(active) : root;
                set({ scopeTab: "directory", directory: dir ?? "" });
              } else set({ scopeTab: id as ScopeTab });
            }}
          />
          <div className={styles.scopeDetail}>
            {s.scopeTab === "directory" && (
              <input
                className={styles.dirInput}
                value={displayDirectory(s.directory, root)}
                placeholder={tx("Directory (relative to project root)")}
                aria-label={tx("Directory")}
                spellCheck={false}
                // Keep the raw text (resolved only when searching), or a typed "/" would be stripped.
                onChange={(e) => set({ directory: e.target.value })}
              />
            )}
            {s.scopeTab === "directory" && (
              <IconButton
                icon="folder-open"
                title="Browse…"
                onClick={() =>
                  void chooseDirectory(resolveDirectory(s.directory, root)).then(
                    (dir) => dir && set({ directory: dir }),
                  )
                }
              />
            )}
            {s.scopeTab === "module" && (
              <Select<string>
                value={s.module}
                options={modules.map((m) => ({
                  value: m.path,
                  label: m.name || m.path || "Project",
                  icon: "module",
                  detail: m.path || undefined,
                }))}
                onChange={(v) => set({ module: v })}
                aria-label="Module"
              />
            )}
            {s.scopeTab === "scope" && (
              <>
                <Select<NamedScope>
                  value={
                    customScopeName(s.namedScope) !== null &&
                    !customScopes.some((c) => customScopeValue(c.name) === s.namedScope)
                      ? "projectFiles"
                      : s.namedScope
                  }
                  options={[
                    ...NAMED_SCOPES,
                    ...(customScopes.length
                      ? [
                          { value: "custom:" as NamedScope, label: "Custom Scopes", section: true },
                          ...customScopes.map((c) => ({
                            value: customScopeValue(c.name),
                            label: c.name,
                            detail: c.pattern,
                          })),
                        ]
                      : []),
                  ]}
                  onChange={(v) => set({ namedScope: v })}
                  aria-label="Named scope"
                />
                <IconButton
                  icon="more-horizontal"
                  title="Edit Scopes…"
                  onClick={() => {
                    const name = customScopeName(s.namedScope);
                    void executeAction(EDIT_SCOPES_ACTION, name ? { select: name } : undefined);
                  }}
                />
              </>
            )}
          </div>
        </div>
        <div className={styles.split}>
          {rows.length ? (
            <SplitGroup orientation="vertical" id="find-popup-split" defaultLayout={split} onLayoutChanged={keepSplit}>
              <SplitPanel id="results" minSize={ROW * 3} defaultSize="48%">
                {resultsBox}
              </SplitPanel>
              <SplitHandle hairline={false} />
              <SplitPanel id="preview" minSize={96}>
                <div className={styles.previewHeader}>
                  {selected ? (
                    <span className={styles.previewPath}>
                      <span className={styles.previewName}>{basename(selected.relPath)}</span>
                      {selected.relPath.includes("/") && dirname(selected.relPath)}
                    </span>
                  ) : (
                    <span />
                  )}
                </div>
                <div className={styles.previewBox}>
                  {!stale && previewMode && s.replace && selected ? (
                    <ReplaceDiffPreview
                      lines={diffPreview?.key === diffPreviewKey ? diffPreview.lines : null}
                      line={selected.line}
                    />
                  ) : (
                    <CodePreview
                      path={selected?.path ?? null}
                      line={selected?.line ?? 0}
                      highlights={fileHighlights}
                      version={previewVersion}
                    />
                  )}
                </div>
              </SplitPanel>
            </SplitGroup>
          ) : (
            resultsBox
          )}
        </div>
        <footer className={styles.footer}>
          <Checkbox checked={s.newTab} onChange={setFindPopupNewTab} label="Open results in new tab" />
          {s.replace && <Checkbox checked={previewMode} onChange={setPreviewMode} label="Preview" />}
          {navigationHint && <span className={styles.hint}>{navigationHint}</span>}
          <span className={styles.spacer} />
          {s.replace && progress && (
            <span className={styles.hint} aria-live="polite">
              {tx`Replacing… ${progress.done}/${progress.total} files`}
            </span>
          )}
          {s.replace && running && (
            <Button onClick={() => running.cancel()}>
              <T>Stop</T>
            </Button>
          )}
          <span className={styles.okHint}>{formatBinding(hostBinding("Meta+Enter"))}</span>
          <Button disabled={!s.pattern} onClick={pin}>
            <T>Open in Find Window</T>
          </Button>
          {s.replace && (
            <>
              <Button
                title={formatBinding("Shift+Alt+Enter")}
                disabled={stale || !rows.length || busy || state.status === "searching"}
                onClick={() => void confirmReplaceAll()}
              >
                <T>Replace All</T>
              </Button>
              <Button variant="primary" disabled={stale || !selected || busy} onClick={() => void replaceSelected()}>
                {pendingSelected > 1 ? txt(`Replace ${pendingSelected} Occurrences`) : <T>Replace</T>}
              </Button>
            </>
          )}
        </footer>
      </div>
      <Menu
        open={maskMenu}
        anchor={maskRef}
        items={maskItems}
        placement="bottom-end"
        onClose={() => setMaskMenu(false)}
      />
      <Menu
        open={historyMenu !== null}
        anchor={historyMenu === "replace" ? replaceBoxRef : patternBoxRef}
        items={historyMenu ? historyItems(historyMenu) : []}
        placement="bottom-start"
        aria-label="Recent searches"
        onClose={() => setHistoryMenu(null)}
      />
      <Menu
        open={contextMenu}
        anchor={contextRef}
        items={contextItems}
        placement="bottom-end"
        aria-label="Search context"
        onClose={() => setContextMenu(false)}
      />
    </Dialog>
  );
}

/** IDEA's header count: shown once something matched. */
function statusText(s: FindState): string {
  if (!s.matchCount) return "";
  const key = s.summary?.limitHit ? "search.find.matchesIncomplete" : "search.find.matches";
  return t(key, { matches: s.matchCount, files: s.files.length });
}

const REGEX_CHARS = /[.$|()[\]{}^?*+\\]/;

/** Whether text with regex syntax in it is also a valid pattern: IDEA then offers "Search with Regex". */
function couldBeRegex(text: string): boolean {
  if (!REGEX_CHARS.test(text)) return false;
  try {
    new RegExp(text);
    return true;
  } catch {
    return false;
  }
}

/** IDEA's empty results text: why nothing is listed, the search options in use and how to clear them. */
function EmptyResults({
  state,
  options: o,
  onClear,
  onRegex,
}: {
  state: FindState;
  options: FindOptions;
  onClear: () => void;
  onRegex: () => void;
}) {
  const masked = o.maskEnabled && !!o.mask.trim();
  if (!o.pattern && !masked) return <div className={styles.empty}>{tx("Type search query to find in files")}</div>;
  if (state.status === "invalid") return <div className={styles.empty}>{state.error ?? tx("Invalid pattern")}</div>;
  if (state.status === "error") return <div className={styles.empty}>{state.error ?? tx("Search failed")}</div>;
  if (o.pattern && state.status !== "done") return <div className={styles.empty}>{tx("Searching…")}</div>;
  const used = [
    o.caseSensitive && { label: "Match Case", key: "Alt+C" },
    o.wholeWord && { label: "Words", key: "Alt+W" },
    o.isRegex && { label: "Regex", key: "Alt+X" },
    masked && { label: "File mask", key: "Alt+K" },
    o.context !== "any" && { label: "Filter", key: "" },
  ].filter((u) => !!u);
  const regex = !!o.pattern && !o.isRegex && couldBeRegex(o.pattern);
  const clearKey = formatBinding("Shift+Alt+Backspace");
  return (
    <div className={styles.empty}>
      <div>
        {o.pattern ? tx("Nothing found") : tx("No search text entered")}
        {used.length || regex ? "." : ""}
      </div>
      {regex ? (
        <div className={styles.emptyOptions}>
          <div>
            <button type="button" className={styles.link} onClick={onRegex}>
              <T>Search with Regex</T>
            </button>{" "}
            {formatBinding("Alt+X")}
          </div>
        </div>
      ) : used.length ? (
        <div className={styles.emptyOptions}>
          {used.length === 1 ? (
            <div>{tx`Search option used: ${tx(used[0]!.label)}`}</div>
          ) : (
            <>
              <div>
                <T>Search options used:</T>
              </div>
              <div>
                {used.map((u) => [tx(u.label), u.key && formatBinding(u.key)].filter(Boolean).join(" ")).join("  ")}
              </div>
            </>
          )}
          <div>
            <button type="button" className={styles.link} onClick={onClear}>
              {used.length === 1 ? <T>Clear option</T> : <T>Clear all options</T>}
            </button>{" "}
            {clearKey}
          </div>
        </div>
      ) : null}
    </div>
  );
}
