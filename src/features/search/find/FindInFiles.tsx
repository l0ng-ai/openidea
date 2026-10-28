import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import clsx from "clsx";
import { openEditorPaths, useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useTxTemplate, tx } from "@/platform/i18n";
import { call, commands, type SearchScope } from "@/platform/ipc";
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
  rememberMask,
  resolveFindScope,
  setFindPopupCommandHandler,
  setFindPopupPinned,
  useFindPopup,
  type FindOptions,
  type BuiltinScope,
  type FindPopupCommand,
  type NamedScope,
  type ScopeTab,
} from "./store";
import { ipcFindDeps, openInFindWindow } from "./windowStore";
import styles from "./FindInFiles.module.css";

const POPUP_MAX_MATCHES = 2000;
const SEARCH_DEBOUNCE_MS = 150;
const ROW = 22;

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
  const root = useProject((p) => p.project?.root ?? null);
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
  const [marks, setMarks] = useState<ReplaceMarks>(NO_MARKS);
  const [running, setRunning] = useState<ReplaceRun | null>(null);
  const [progress, setProgress] = useState<ReplaceProgress | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [diffPreview, setDiffPreview] = useState<{ key: string; lines: PreviewLine[] } | null>(null);
  const busy = !!running;
  const patternRef = useRef<HTMLInputElement>(null);
  const patternBoxRef = useRef<HTMLDivElement>(null);
  const replaceBoxRef = useRef<HTMLDivElement>(null);
  const maskRef = useRef<HTMLDivElement>(null);
  const maskInputRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLButtonElement>(null);
  const set = (patch: Partial<FindOptions>) => useFindPopup.setState(patch);

  useEffect(() => () => session.dispose(), [session]);

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

  const [rerun, setRerun] = useState(0);
  useEffect(() => {
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
    if (!selected) return [];
    const f = state.files.find((x) => x.path === selected.path);
    return (f?.matches ?? []).map((m) => ({
      line: m.line,
      ranges: m.ranges.map(([a, b]) => [a + m.textOffset, b + m.textOffset] as [number, number]),
    }));
  }, [selected, state.files]);

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
    openInFindWindow(pinned, describeQuery(pinned, root), s.replace ? s.replacement : null, undefined, s.preserveCase);
  };

  /** IDEA asks before Replace All only when the results span more than one file. */
  const confirmReplaceAll = async () => {
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
    if (!usages.length || running) return null;
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
  const skip = () => {
    const i = nextPending(rows, rows.indexOf(chosen[chosen.length - 1]!), marks);
    if (i >= 0) setIndex(i);
  };
  const replaceInFile = async () => {
    if (!selected) return;
    const next = await replaceUsages(
      pendingUsages(
        rows.filter((r) => r.path === selected.path),
        marks,
      ),
    );
    if (next) {
      const i = nextPending(rows, active, next);
      if (i >= 0) setIndex(i);
    }
  };
  const replaceAll = async (usages: Usage[]) => {
    const done = await replaceUsages(usages);
    if (done) close();
  };

  useEffect(() => {
    if (!previewMode || !s.replace || !selected) return;
    let alive = true;
    const key = selected.key;
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
  }, [previewMode, s.replace, selected?.key, s.replacement, s.preserveCase, queryKey, marks, previewVersion]);

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
      set({ maskEnabled: !s.maskEnabled });
      if (!s.maskEnabled) setTimeout(() => maskInputRef.current?.select(), 0);
    } else if (code === "KeyE" && s.replace) set({ preserveCase: !s.preserveCase });
    else if (code === "KeyA" && s.replace) {
      if (rows.length && !busy) void confirmReplaceAll();
    } else return false;
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inField =
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA") && target.closest("[data-find-field]");
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

  const summary = statusText(state);
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
  const pendingSelected = s.replace ? pendingUsages(chosen, marks).length : 0;

  return (
    <Dialog
      open
      onClose={close}
      width={820}
      position="top"
      transparentBackdrop
      // IDEA's Find in Files is a modeless dialog: it survives switching to another app.
      closeOnDeactivate={false}
      dismissOnBackdrop={!s.pinned}
      aria-label={s.replace ? "Replace in Files" : "Find in Files"}
      className={styles.dialog}
    >
      <div className={styles.root} onKeyDown={onKeyDown}>
        <header className={styles.header}>
          <span className={styles.title}>{s.replace ? tx("Replace in Files") : tx("Find in Files")}</span>
          <span className={styles.status} aria-live="polite">
            {state.status === "searching" || state.status === "validating" ? <Spinner size={12} /> : null}
            {summary}
          </span>
          <span className={styles.spacer} />
          <Checkbox checked={s.maskEnabled} onChange={(v) => set({ maskEnabled: v })} label="File mask:" />
          <div ref={maskRef} className={clsx(styles.mask, !s.maskEnabled && styles.maskOff)}>
            <input
              ref={maskInputRef}
              className={styles.maskInput}
              value={s.mask}
              placeholder="*.kt, !*Test*"
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
                  shortcut: "⌥C",
                  pressed: s.caseSensitive,
                  onToggle: (v) => set({ caseSensitive: v }),
                },
                {
                  id: "word",
                  icon: "word",
                  title: "Words",
                  shortcut: "⌥W",
                  pressed: s.wholeWord,
                  onToggle: (v) => set({ wholeWord: v }),
                },
                {
                  id: "regex",
                  icon: "regex",
                  title: "Regex",
                  shortcut: "⌥X",
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
                    shortcut: "⌥E",
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
                const dir = active && root && active.startsWith(root + "/") ? dirname(active) : root;
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
                          { value: "custom:" as NamedScope, label: "Custom Scopes", disabled: true },
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
        <div className={styles.results}>
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
            empty={<span>{emptyText(state, s.pattern)}</span>}
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
                      ranges={r.ranges}
                      source={{ path: r.path, line: r.line, col: r.textCol }}
                      active={st.active}
                      replacement={s.replace && state !== "done" ? s.replacement : null}
                      query={query}
                      preserveCase={s.preserveCase}
                    />
                  </span>
                  <span className={clsx(styles.rowFile, st.active && styles.rowFileActive)}>
                    {state === "done" && (
                      <span className={styles.rowLine}>
                        <T>replaced ·</T>{" "}
                      </span>
                    )}
                    {basename(r.relPath)} <span className={styles.rowLine}>{r.line + 1}</span>
                  </span>
                </>
              );
            }}
          />
        </div>
        <div className={styles.previewHeader}>
          {selected ? (
            <>
              <span className={styles.previewPath}>{selected.relPath}</span>
              <span className={styles.rowLine}>
                {selected.line + 1}:{selected.col + 1}
              </span>
            </>
          ) : (
            <span />
          )}
        </div>
        <div className={styles.previewBox}>
          {previewMode && s.replace && selected ? (
            <ReplaceDiffPreview
              lines={diffPreview?.key === selected.key ? diffPreview.lines : null}
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
        <footer className={styles.footer}>
          <span className={styles.hint}>
            {s.replace ? (
              <T>↵ Replace Selected · ⇧⌥↵ Replace All · ⌘↵ Open in Find Window</T>
            ) : (
              <T>↵ Open · ⇧↵ Open to the side · ⌘↵ Open in Find Window</T>
            )}
          </span>
          <span className={styles.spacer} />
          {s.replace && progress && (
            <span className={styles.hint} aria-live="polite">
              {tx`Replacing… ${progress.done}/${progress.total} files`}
            </span>
          )}
          {s.replace && running && (
            <Button size="small" onClick={() => running.cancel()}>
              <T>Stop</T>
            </Button>
          )}
          {s.replace && (
            <>
              <Checkbox checked={previewMode} onChange={setPreviewMode} label="Preview" />
              <Button size="small" variant="secondary" disabled={!selected || busy} onClick={skip}>
                <T>Skip</T>
              </Button>
              <Button size="small" disabled={!selected || busy} onClick={() => void replaceSelected()}>
                {pendingSelected > 1 ? txt(`Replace ${pendingSelected} Occurrences`) : <T>Replace</T>}
              </Button>
              <Button size="small" disabled={!selected || busy} onClick={() => void replaceInFile()}>
                <T>Replace All in This File</T>
              </Button>
              <Button
                size="small"
                title="Replace All (⇧⌥↵, ⌥A)"
                disabled={!rows.length || busy || state.status === "searching"}
                onClick={() => void confirmReplaceAll()}
              >
                <T>Replace All</T>
              </Button>
            </>
          )}
          <Button size="small" variant={s.replace ? "secondary" : "primary"} disabled={!s.pattern} onClick={pin}>
            <T>Open in Find Window</T>
          </Button>
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

function statusText(s: FindState): string {
  if (s.status === "invalid") return "Invalid pattern";
  if (s.status === "error") return s.error ?? "Search failed";
  if (s.status === "idle") return "";
  const files = s.files.length;
  const more = s.summary?.limitHit ? "+" : "";
  if (!s.matchCount) return s.status === "done" ? "No matches" : "Searching…";
  return `${s.matchCount}${more} match${s.matchCount === 1 ? "" : "es"} in ${files}${more} file${files === 1 ? "" : "s"}`;
}

function emptyText(s: FindState, pattern: string): string {
  if (!pattern) return "Type text to search the project";
  if (s.status === "invalid") return s.error ?? "Invalid pattern";
  if (s.status === "searching" || s.status === "validating") return "Searching…";
  if (s.status === "error") return s.error ?? "Search failed";
  return "Nothing found";
}
