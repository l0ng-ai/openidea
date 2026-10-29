import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import clsx from "clsx";
import { editorsFor, getNavigationHistory } from "@/editor/api";
import { call, commands, type OutlineItem } from "@/platform/ipc";
import { shortcutLabel } from "@/platform/keymap";
import { useProject } from "@/platform/project";
import { Checkbox, Dialog, HighlightedText, Icon, List, fileIconName, listNavigate, T } from "@/ui";
import {
  maybeEditorService,
  toolWindowService,
  useContributions,
  useFileDecoration,
  type OpenEditorTab,
  type ToolWindowContribution,
} from "@/workbench/contributions";
import { highlightTokens, languageForPath, type CodeToken } from "@/editor/lsp/markdown";
import { basename, openLocation } from "../common/open";
import { outlinePathAt } from "../structure/outline";
import { fromNavigationHistory, isDismissed, mergeLocations, type RecentLocation } from "../common/locations";
import { dismissLocation, useTracking } from "../common/tracking";
import {
  filterLocations,
  filterRecentFiles,
  initialFileIndex,
  lineSegments,
  locationBreadcrumb,
  locationTime,
  switcherItems,
  switcherPaths,
  switcherSelection,
  switcherToolWindows,
  type RecentFileItem,
} from "./model";
import { showSearchEverywhere } from "../everywhere/store";
import { cycleSwitcher, hideRecentPopup, showRecentPopup, useRecentPopup } from "./store";
import styles from "./RecentPopups.module.css";
import { tx } from "@/platform/i18n";

export function RecentPopupsOverlay() {
  const open = useRecentPopup((s) => s.open);
  const session = useRecentPopup((s) => s.session);
  if (open === "files") return <RecentFilesDialog key={session} />;
  if (open === "locations") return <RecentLocationsDialog />;
  return null;
}

const NAV_KEYS = ["ArrowDown", "ArrowUp", "PageDown", "PageUp"];

/** Defers work until the dialog unmounted and restored focus. */
const afterClose = (fn: () => void) => {
  hideRecentPopup();
  setTimeout(fn, 0);
};

// ---------------------------------------------------------------------------
// ⌘E — Recent Files; ⌃⇥ — Switcher (open editors only, no speed search)

function RecentFilesDialog() {
  const editedOnly = useRecentPopup((s) => s.editedOnly);
  const switcher = useRecentPopup((s) => s.switcher);
  const step = useRecentPopup((s) => s.step);
  const edited = useTracking((s) => s.edited);
  const root = useProject((s) => s.project?.root ?? null);
  const toolWindows = useContributions((s) => s.toolWindows);
  const [paths, setPaths] = useState<string[] | null>(null);
  // Switcher: the open editor tabs (files and others), when the editor service lists them.
  const [tabs] = useState<OpenEditorTab[] | null>(() =>
    switcher ? (maybeEditorService()?.openTabs?.() ?? null) : null,
  );
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [column, setColumn] = useState<"files" | "tools">("files");
  const [fileIndex, setFileIndex] = useState<number | null>(null);
  const [toolIndex, setToolIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The current editor: a file path, or the key of a non-file editor (Switcher lists those too).
  const activePath = useMemo(() => {
    const top = tabs?.[0];
    if (top && top.lastActive > 0 && top.input.kind !== "file" && top.input.kind !== "virtual") return top.input.key;
    return maybeEditorService()?.activePath() ?? null;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    const openNow = () => maybeEditorService()?.openPaths?.() ?? [];
    call(commands.recentFiles())
      .then((p) => {
        const recent = p.map(String);
        if (alive) setPaths(switcher ? switcherPaths(recent, openNow()) : recent);
      })
      .catch(() => alive && setPaths(switcher ? openNow() : []));
    return () => {
      alive = false;
    };
  }, [switcher]);

  const files = useMemo(
    () =>
      tabs
        ? switcherItems(paths ?? [], tabs, query, root).filter((f) => !removed.has(f.path))
        : filterRecentFiles(
            (paths ?? []).filter((p) => !removed.has(p)),
            query,
            { root, edited, editedOnly },
          ),
    [paths, tabs, removed, query, root, edited, editedOnly],
  );
  const tools = useMemo(() => switcherToolWindows(toolWindows.values(), !!root, query), [toolWindows, root, query]);
  const fIndex = files.length
    ? Math.min(fileIndex ?? initialFileIndex(files, activePath, query), files.length - 1)
    : -1;
  const tIndex = tools.length ? Math.min(toolIndex, tools.length - 1) : -1;
  const effectiveColumn = column === "files" && !files.length && tools.length ? "tools" : column;

  const openFile = (item: RecentFileItem | undefined, side = false) => {
    if (!item) return;
    const editor = item.editor;
    afterClose(() =>
      editor
        ? void maybeEditorService()?.openInput(editor.input, { side, focus: true })
        : void openLocation(item.path, null, { side }),
    );
  };

  const openTool = (tw: ToolWindowContribution | undefined) => {
    if (tw) afterClose(() => toolWindowService().show(tw.id, true));
  };

  // IDEA: Delete closes the selected editor (and drops it from the list) or hides the tool window.
  const removeSelected = async () => {
    if (effectiveColumn === "tools") {
      const tw = tools[tIndex]?.tw;
      if (tw) toolWindowService().hide(tw.id);
      return;
    }
    const item = files[fIndex];
    if (!item) return;
    const closed = item.editor
      ? await maybeEditorService()?.closeInput?.(item.path)
      : await maybeEditorService()?.closePath?.(item.path);
    if (closed === false) return;
    if (!switcher) void call(commands.removeRecent(item.path)).catch(() => {});
    setRemoved((r) => new Set(r).add(item.path));
    setFileIndex(fIndex);
  };

  // Switcher: each ⌃⇥ moves one row, past the end into the other column; releasing Ctrl opens the selection.
  const baseIndex = useRef<number | null>(null);
  const loaded = paths !== null;
  useEffect(() => {
    if (!switcher || !loaded) return;
    // ⌃⇥ starts on the previous file, ⌃⇧⇥ on the oldest one.
    baseIndex.current ??= step < 0 ? files.length : Math.max(0, initialFileIndex(files, activePath, ""));
    const sel = switcherSelection(baseIndex.current, step, files.length, tools.length);
    if (!sel) return;
    // The switcher step is an external event (⌃⇥ pressed again).
    setColumn(sel.column);
    if (sel.column === "files") setFileIndex(sel.index);
    else setToolIndex(sel.index);
    // Only a new ⌃⇥ press moves the selection, not list changes (Delete).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcher, step, loaded]);
  const selected = effectiveColumn === "files" ? files[fIndex] : undefined;
  const selectedTool = effectiveColumn === "tools" ? tools[tIndex]?.tw : undefined;
  useEffect(() => {
    if (!switcher) return;
    const onKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Control") return;
      if (selected) openFile(selected);
      else if (selectedTool) openTool(selectedTool);
      else hideRecentPopup();
    };
    window.addEventListener("keyup", onKeyUp, true);
    return () => window.removeEventListener("keyup", onKeyUp, true);
  });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (effectiveColumn === "files" && !files[fIndex] && query.trim()) {
        // Nothing recent matches: carry the text over to Go to File.
        const text = query.trim();
        afterClose(() => showSearchEverywhere("files", { query: text }));
      } else if (effectiveColumn === "files") openFile(files[fIndex], e.shiftKey);
      else openTool(tools[tIndex]?.tw);
      return;
    }
    if (e.key === "Tab" && e.ctrlKey) {
      // Normally handled by the global ⌃⇥ binding; kept here for presets without it.
      e.preventDefault();
      cycleSwitcher(e.shiftKey ? -1 : 1);
      return;
    }
    // In Recent Files Backspace edits the speed search text first.
    if (e.key === "Delete" || (e.key === "Backspace" && !query)) {
      e.preventDefault();
      void removeSelected();
      return;
    }
    if (e.key === "Tab" || ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !query)) {
      e.preventDefault();
      e.stopPropagation();
      setColumn(
        e.key === "ArrowLeft"
          ? "tools"
          : e.key === "ArrowRight"
            ? "files"
            : effectiveColumn === "files"
              ? "tools"
              : "files",
      );
      return;
    }
    if (!NAV_KEYS.includes(e.key)) return;
    e.preventDefault();
    if (effectiveColumn === "files") {
      const next = listNavigate(e.key, { items: files, active: fIndex, wrap: true });
      if (next !== null) setFileIndex(next);
    } else {
      const next = listNavigate(e.key, { items: tools, active: tIndex, wrap: true });
      if (next !== null) setToolIndex(next);
    }
  };

  const recentShortcut = shortcutLabel("navigate.recentFiles");
  const locationsShortcut = shortcutLabel("navigate.recentLocations");
  const title = switcher ? "Switcher" : editedOnly ? "Recently Edited Files" : "Recent Files";
  const footerPath = (selected?.editor ? selected.rel : selected?.path) ?? (selectedTool ? "" : (root ?? ""));
  return (
    <Dialog open onClose={hideRecentPopup} width={720} aria-label={title} className={styles.dialog}>
      <header className={styles.header}>
        <span className={styles.title}>
          <T>{title}</T>
        </span>
        {!switcher && (
          <>
            <span className={clsx(styles.speed, query && styles.speedActive)}>
              <Icon name="search" size={14} className={styles.filterIcon} />
              <input
                ref={inputRef}
                data-autofocus
                className={styles.filter}
                value={query}
                spellCheck={false}
                autoComplete="off"
                aria-label={tx("Filter recent files")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setFileIndex(null);
                  setToolIndex(0);
                }}
                onKeyDown={onKeyDown}
              />
            </span>
            <Checkbox
              checked={editedOnly}
              onChange={() => {
                showRecentPopup("files");
                inputRef.current?.focus();
              }}
              label={
                <>
                  <T>Show edited only</T> {recentShortcut && <span className={styles.hint}>{recentShortcut}</span>}
                </>
              }
            />
          </>
        )}
      </header>
      <div
        className={styles.columns}
        tabIndex={switcher ? -1 : undefined}
        data-autofocus={switcher ? "" : undefined}
        onKeyDown={switcher ? onKeyDown : undefined}
      >
        <div className={styles.tools}>
          <List
            items={tools}
            getKey={(t) => t.tw.id}
            activeIndex={effectiveColumn === "tools" ? tIndex : -1}
            onActiveChange={(i) => {
              setToolIndex(i);
              setColumn("tools");
            }}
            onActivate={(t) => openTool(t.tw)}
            focusable={false}
            rowHeight={24}
            aria-label="Tool windows"
            renderItem={(t) => <ToolRow tw={t.tw} indices={t.indices} />}
          />
          {!switcher && (
            <button
              type="button"
              className={styles.locationsLink}
              onClick={() => afterClose(() => showRecentPopup("locations"))}
            >
              <span className={styles.name}>
                <T>Recent Locations</T>
              </span>
              {locationsShortcut && <span className={styles.shortcut}>{locationsShortcut}</span>}
            </button>
          )}
        </div>
        <div className={styles.files}>
          <List
            items={files}
            getKey={(f) => f.path}
            activeIndex={effectiveColumn === "files" ? fIndex : -1}
            onActiveChange={(i) => {
              setFileIndex(i);
              setColumn("files");
            }}
            onActivate={(f, _i, e) => openFile(f, e.shiftKey)}
            focusable={false}
            rowHeight={24}
            aria-label={switcher ? "Open files" : "Recent files"}
            empty={
              paths && (
                <span>
                  {switcher
                    ? tx("No open files")
                    : editedOnly
                      ? tx("No edited files")
                      : query
                        ? tx("No matching files")
                        : tx("No recent files")}
                </span>
              )
            }
            renderItem={(f) => <RecentFileRow item={f} current={f.path === activePath} />}
          />
        </div>
      </div>
      <footer className={styles.footer} title={footerPath}>
        <span className={styles.footerPath}>
          <bdi>{footerPath}</bdi>
        </span>
      </footer>
    </Dialog>
  );
}

function ToolRow({ tw, indices }: { tw: ToolWindowContribution; indices: number[] }) {
  const shortcut = shortcutLabel(`toolwindow.${tw.id}`);
  return (
    <>
      <Icon name={tw.icon} size={16} className={styles.icon} />
      <HighlightedText className={styles.name} text={tw.title} indices={indices} tone="strong" />
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
    </>
  );
}

function RecentFileRow({ item, current }: { item: RecentFileItem; current: boolean }) {
  const deco = useFileDecoration(item.editor ? "" : item.path);
  return (
    <>
      <Icon name={item.editor?.icon ?? fileIconName(item.name)} size={16} className={styles.icon} />
      <span
        className={clsx(styles.name, current && styles.current)}
        style={deco.color ? { color: deco.color } : undefined}
      >
        <HighlightedText text={item.name} indices={item.indices} tone="strong" />
      </span>
      <span className={styles.dir}>{item.dir}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// ⇧⌘E — Recent Locations

function navigationHistory(): RecentLocation[] {
  try {
    return fromNavigationHistory(getNavigationHistory()) ?? [];
  } catch {
    return [];
  }
}

/** Fills missing snippets from open editors or locally recorded locations. */
function withSnippets(list: RecentLocation[], recorded: readonly RecentLocation[]): RecentLocation[] {
  return list.map((l) => {
    if (l.snippet.length) return l;
    const view = editorsFor(l.path)[0]?.view;
    if (view && l.line < view.state.doc.lines) {
      const start = Math.max(0, l.line - 1);
      const end = Math.min(view.state.doc.lines - 1, l.line + 1);
      const snippet: string[] = [];
      for (let n = start; n <= end; n++) snippet.push(view.state.doc.line(n + 1).text.slice(0, 300));
      return { ...l, snippet, snippetStart: start };
    }
    const near = recorded.find((r) => r.path === l.path && Math.abs(r.line - l.line) <= 1);
    return near ? { ...l, snippet: near.snippet, snippetStart: near.snippetStart } : l;
  });
}

const LOCATION_ROW = 78;

function breadcrumbOf(outline: readonly OutlineItem[] | undefined, l: RecentLocation): string {
  return outline ? locationBreadcrumb(outlinePathAt(outline, { line: l.line, col: l.col })) : "";
}

/** Strips the common indentation so snippets line up at the left edge. */
function dedent(lines: readonly string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(min, l.length - l.trimStart().length)));
}

/** Outlines of the open documents among `paths` (breadcrumbs); closed files get none. */
function useOpenOutlines(paths: readonly string[]): ReadonlyMap<string, OutlineItem[]> {
  const [outlines, setOutlines] = useState<ReadonlyMap<string, OutlineItem[]>>(() => new Map());
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const path of new Set(paths)) {
      if (requested.current.has(path)) continue;
      const doc = editorsFor(path)[0]?.ctx.doc;
      if (doc === undefined) continue;
      requested.current.add(path);
      call(commands.docOutline(doc))
        .then((items) => setOutlines((m) => new Map(m).set(path, items)))
        .catch(() => {});
    }
  }, [paths]);
  return outlines;
}

const tokenCache = new Map<string, CodeToken[]>();

/** A snippet's lines coloured by the file's language (parsed together, so multi-line constructs colour right). */
function SnippetCode({
  path,
  lines,
  first,
  caret,
}: {
  path: string;
  lines: readonly string[];
  first: number;
  caret: number;
}) {
  const language = useMemo(() => languageForPath(path), [path]);
  const text = lines.join("\n");
  const key = `${language}\u0000${text}`;
  const [loaded, setLoaded] = useState<{ key: string; tokens: CodeToken[] } | null>(null);
  const tokens = tokenCache.get(key) ?? (loaded?.key === key ? loaded.tokens : null);
  useEffect(() => {
    if (tokens || !language) return;
    let alive = true;
    void highlightTokens(text, language).then((t) => {
      tokenCache.set(key, t);
      if (tokenCache.size > 200) tokenCache.delete(tokenCache.keys().next().value!);
      if (alive) setLoaded({ key, tokens: t });
    });
    return () => {
      alive = false;
    };
  }, [key, language, text, tokens]);
  const segments = useMemo(() => lineSegments(lines, tokens ?? []), [lines, tokens]);
  return (
    <pre className={styles.snippet}>
      {segments.map((segs, i) => (
        <div key={i} className={clsx(styles.snippetLine, first + i === caret && styles.caretLine)}>
          <span className={styles.lineNo}>{first + i + 1}</span>
          <span className={styles.code}>
            {segs.length
              ? segs.map((seg, j) =>
                  seg.cls ? (
                    <span key={j} className={seg.cls}>
                      {seg.text}
                    </span>
                  ) : (
                    seg.text
                  ),
                )
              : " "}
          </span>
        </div>
      ))}
    </pre>
  );
}

function RecentLocationsDialog() {
  const changedOnly = useRecentPopup((s) => s.changedOnly);
  const recorded = useTracking((s) => s.locations);
  const dismissed = useTracking((s) => s.dismissed);
  const root = useProject((s) => s.project?.root ?? null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const source = useMemo(() => {
    const all = withSnippets(mergeLocations(navigationHistory(), recorded), recorded);
    return dismissed.length ? all.filter((l) => !isDismissed(l, dismissed)) : all;
  }, [recorded, dismissed]);
  const items = useMemo(
    () => filterLocations(source, query, { changedOnly, root }),
    [source, query, changedOnly, root],
  );
  const active = items.length ? Math.min(index, items.length - 1) : -1;
  const paths = useMemo(() => items.map((l) => l.path), [items]);
  const outlines = useOpenOutlines(paths);
  // Relative times as of opening the popup.
  const [now] = useState(() => Date.now());

  const open = (l: RecentLocation | undefined, side = false) => {
    if (l) afterClose(() => void openLocation(l.path, { line: l.line, col: l.col }, { side }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      open(items[active], e.shiftKey);
      return;
    }
    // IDEA: Delete removes the selected place (Backspace too while there is no filter text).
    if ((e.key === "Delete" || (e.key === "Backspace" && !query)) && items[active]) {
      e.preventDefault();
      dismissLocation(items[active]!);
      return;
    }
    if (!NAV_KEYS.includes(e.key)) return;
    e.preventDefault();
    const next = listNavigate(e.key, { items, active, wrap: true, pageSize: 4 });
    if (next !== null) setIndex(next);
  };

  return (
    <Dialog open onClose={hideRecentPopup} width={720} aria-label="Recent Locations" className={styles.dialog}>
      <header className={styles.header}>
        <span className={styles.title}>{changedOnly ? tx("Recently Changed Locations") : tx("Recent Locations")}</span>
        <span className={clsx(styles.speed, styles.speedWide, query && styles.speedActive)}>
          <Icon name="search" size={14} className={styles.filterIcon} />
          <input
            ref={inputRef}
            data-autofocus
            className={styles.filter}
            value={query}
            placeholder={tx("Type to filter by file name or code")}
            spellCheck={false}
            autoComplete="off"
            aria-label={tx("Filter recent locations")}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
        </span>
        <Checkbox
          checked={changedOnly}
          onChange={() => {
            showRecentPopup("locations");
            inputRef.current?.focus();
          }}
          label={
            <>
              <T>Show changed only</T> <span className={styles.hint}>{shortcutLabel("navigate.recentLocations")}</span>
            </>
          }
        />
      </header>
      <div className={styles.locations}>
        <List
          items={items}
          getKey={(l) => `${l.path}:${l.line}:${l.time}`}
          activeIndex={active}
          onActiveChange={setIndex}
          onActivate={(l, _i, e) => {
            // A click selects (and previews the place); a double click opens it.
            if (e.type === "click" && (e as ReactMouseEvent).detail < 2) return;
            open(l, e.shiftKey);
          }}
          focusable={false}
          rowHeight={LOCATION_ROW}
          aria-label="Recent locations"
          empty={<span>{changedOnly ? tx("No changed locations") : tx("No recent locations")}</span>}
          renderItem={(l) => (
            <div className={styles.location}>
              <div className={styles.locationHeader}>
                <Icon name={fileIconName(basename(l.rel))} size={14} className={styles.icon} />
                <HighlightedText
                  className={styles.locationName}
                  text={basename(l.rel)}
                  indices={l.nameIndices}
                  tone="strong"
                />
                <span className={styles.dir}>{breadcrumbOf(outlines.get(l.path), l) || l.rel}</span>
                {l.changed && (
                  <span className={styles.changed}>
                    <T>changed</T>
                  </span>
                )}
                <span className={styles.time}>{locationTime(l.time, now)}</span>
              </div>
              <SnippetCode path={l.path} lines={dedent(l.snippet)} first={l.snippetStart} caret={l.line} />
            </div>
          )}
        />
      </div>
    </Dialog>
  );
}
