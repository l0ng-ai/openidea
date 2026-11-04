/**
 * ⌥⌘F7 Show Usages: popup at the caret with the usages grouped by file, speed
 * search (typing filters), a code preview of the selected usage beside the
 * list and "Open in Find Window", which moves the found usages to the Find
 * Usages tool window.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { codePreviewExtensions } from "@/editor/api";
import { basename, relativeDir, useProject } from "@/platform/project";
import { shortcutLabel } from "@/platform/keymap";
import { Icon, IconButton, List, Popup, fileIconName, listNavigate } from "@/ui";
import { openLocation, readFileLines } from "./ipc";
import {
  dismissUsagesPopup,
  showUsageResults,
  usageCount,
  useUsagesPopup,
  type Usage,
  type UsageGroup,
} from "./usages";
import { UsagePreview } from "./UsagesView";
import styles from "./UsagesPopup.module.css";
import { tx } from "@/platform/i18n";

import { UsageAccessFilter, filterUsageAccess, useUsageAccessOptions } from "./UsageAccessFilter";

const close = dismissUsagesPopup;

const PREVIEW_KEY = "openidea.usages.popupPreview.v1";

function loadPreviewOption(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "false";
  } catch {
    return true;
  }
}

/** The preview pane toggle (remembered). */
export const useUsagesPopupPreview = create<{ preview: boolean }>(() => ({ preview: loadPreviewOption() }));

export function setUsagesPopupPreview(preview: boolean) {
  useUsagesPopupPreview.setState({ preview });
  try {
    localStorage.setItem(PREVIEW_KEY, String(preview));
  } catch {
    // storage unavailable: the toggle lasts for the session
  }
}

/** Usages whose file name or line text contains the typed text (case-insensitive). */
export function filterUsages(items: readonly Usage[], filter: string): Usage[] {
  const q = filter.trim().toLowerCase();
  if (!q) return items as Usage[];
  return items.filter((u) => u.text.toLowerCase().includes(q) || basename(u.path).toLowerCase().includes(q));
}

/** Groups a flat usage list by file, keeping the order of both (filters preserve it). */
export function regroupUsages(usages: readonly Usage[]): UsageGroup[] {
  const byPath = new Map<string, Usage[]>();
  for (const u of usages) {
    const list = byPath.get(u.path);
    if (list) list.push(u);
    else byPath.set(u.path, [u]);
  }
  return [...byPath.entries()].map(([path, list]) => ({ path, usages: list }));
}

/** The popup's groups as locations for the Find Usages tool window. */
export function usageLocations(groups: readonly UsageGroup[]) {
  return groups.flatMap((g) =>
    g.usages.map(
      (u) =>
        u.sourceLocation ?? {
          path: u.path,
          range: { start: { line: u.line, col: u.col }, end: { line: u.line, col: u.endCol } },
        },
    ),
  );
}

export function UsagesPopup() {
  const open = useUsagesPopup((s) => s.open);
  return open ? <UsagesPopupInner /> : null;
}

const ROW = 24;
const SECTION = 26;

/** A list row: a file's header, or one of the usages under it. */
type Row = { kind: "file"; key: string; group: UsageGroup } | { kind: "usage"; key: string; usage: Usage };

const usageKey = (u: Usage) =>
  `${u.path}:${u.line}:${u.col}:${u.sourceLocation?.range.end.line ?? u.line}:${u.sourceLocation?.range.end.col ?? u.endCol}`;

/** `active` when it is a usage row, else the first usage row (-1 when there is none). */
function activeRow(active: number, rows: readonly Row[]): number {
  const i = Math.min(active, rows.length - 1);
  if (rows[i]?.kind === "usage") return i;
  return rows.findIndex((r) => r.kind === "usage");
}

function UsagesPopupInner() {
  const { anchor, symbol, heading, groups, note } = useUsagesPopup();
  const preview = useUsagesPopupPreview((s) => s.preview);
  const root = useProject((s) => s.project?.root ?? "");
  const all = useMemo<Usage[]>(() => groups.flatMap((g) => g.usages), [groups]);
  const [filter, setFilter] = useState("");
  const accessOptions = useUsageAccessOptions();
  const visible = useMemo(
    () => regroupUsages(filterUsages(filterUsageAccess(all, accessOptions), filter)),
    [all, filter, accessOptions],
  );
  const rows = useMemo<Row[]>(
    () =>
      visible.flatMap((g): Row[] => [
        { kind: "file", key: g.path, group: g },
        ...g.usages.map((u): Row => ({ kind: "usage", key: usageKey(u), usage: u })),
      ]),
    [visible],
  );
  const [active, setActive] = useState(0);
  const current = activeRow(active, rows);
  const currentUsage = rows[current]?.kind === "usage" ? rows[current].usage : null;
  const visibleCount = rows.reduce((n, r) => n + (r.kind === "usage" ? 1 : 0), 0);
  const total = usageCount(groups);
  const pick = (row: Row | undefined) => {
    if (row?.kind !== "usage") return;
    close();
    void openLocation(row.usage.path, row.usage.line, row.usage.col);
  };
  const openInFindWindow = () => {
    close();
    void showUsageResults({
      symbol,
      note,
      locations: usageLocations(groups),
      classified: groups.flatMap((g) =>
        g.usages.map((u) => ({
          location: usageLocations([{ path: g.path, usages: [u] }])[0]!,
          kind: u.kind ?? "unknown",
          access: u.access,
        })),
      ),
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" && e.target instanceof Element && e.target.closest("button")) return;
    const next = listNavigate(e.key, {
      items: rows,
      active: current,
      isSection: (r) => r.kind === "file",
      wrap: true,
      pageSize: 10,
    });
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      return;
    }
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[current]);
    } else if (e.key === "Escape" && filter) {
      // The first Esc clears the speed search, the next one closes.
      e.preventDefault();
      e.stopPropagation();
      setFilter("");
      setActive(0);
    } else if (e.key === "Backspace" && filter) {
      e.preventDefault();
      setFilter((f) => f.slice(0, -1));
      setActive(0);
    } else if (plain && e.key.length === 1 && (filter || e.key !== " ")) {
      e.preventDefault();
      setFilter((f) => f + e.key);
      setActive(0);
    }
  };

  const keys = shortcutLabel("find.usages");
  const contentHeight = visible.reduce((h, g) => h + SECTION + g.usages.length * ROW, 0);
  const height = preview
    ? Math.max(10 * ROW, Math.min(16 * ROW, contentHeight))
    : Math.max(ROW, Math.min(14 * ROW, contentHeight));
  return (
    <Popup open anchor={anchor} onClose={close} aria-label="Usages" className={styles.popup}>
      <div className={styles.focus} tabIndex={0} data-autofocus onKeyDown={onKeyDown}>
        <div className={styles.header}>
          <span className={styles.title}>
            {heading ?? (symbol ? tx`Usages of ${symbol}` : tx("Usages"))}{" "}
            <span className={styles.count}>
              {filter || visibleCount !== total ? tx`${visibleCount} of ${total} found` : tx`${total} found`}
            </span>
          </span>
          {filter && (
            <span className={clsx(styles.filter, !visibleCount && styles.noMatch)} role="status">
              {filter}
            </span>
          )}
          <IconButton
            icon="list"
            size="small"
            title="Show Preview"
            pressed={preview}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setUsagesPopupPreview(!preview)}
          />
          <button type="button" className={styles.link} onClick={openInFindWindow}>
            {tx("Open in Find Window")}
            {keys ? ` ${keys}` : ""}
          </button>
        </div>
        <UsageAccessFilter items={all} />
        {note && <div className={styles.note}>{note}</div>}
        <div className={styles.body} style={{ height }}>
          {preview && (
            <div className={styles.previewPane}>
              <UsageCodePreview usage={currentUsage} />
            </div>
          )}
          <List
            className={styles.list}
            items={rows}
            getKey={(r) => r.key}
            isSection={(r) => r.kind === "file"}
            renderSection={(r) => (r.kind === "file" ? <FileRow group={r.group} root={root} /> : null)}
            activeIndex={current}
            onActiveChange={setActive}
            focusable={false}
            hoverSelects
            rowHeight={ROW}
            sectionHeight={SECTION}
            aria-label="Usages"
            onActivate={pick}
            empty={
              <div className={styles.empty}>
                {filter ? tx`Nothing matches '${filter}'` : tx("No usages match the access filters")}
              </div>
            }
            renderItem={(r) =>
              r.kind === "usage" ? (
                <span className={styles.row}>
                  <span className={styles.line}>{r.usage.line + 1}</span>
                  <UsagePreview usage={r.usage} />
                </span>
              ) : null
            }
          />
        </div>
      </div>
    </Popup>
  );
}

function FileRow({ group, root }: { group: UsageGroup; root: string }) {
  return (
    <span className={styles.fileRow}>
      <Icon name={fileIconName(basename(group.path), group.path)} size={14} className={styles.icon} />
      <span className={styles.file}>{basename(group.path)}</span>
      <span className={styles.dir}>{relativeDir(root, group.path)}</span>
      <span className={styles.count}>
        {group.usages.length} {tx(group.usages.length === 1 ? "usage" : "usages")}
      </span>
    </span>
  );
}

const setMark = StateEffect.define<{ from: number; to: number } | null>();
const usageMark = Decoration.mark({ class: styles.previewMatch });
const usageLine = Decoration.line({ class: styles.previewLine });
const marks = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setMark)) continue;
      if (!e.value) return Decoration.none;
      const line = tr.state.doc.lineAt(e.value.from);
      const ranges = [usageLine.range(line.from)];
      if (e.value.to > e.value.from) ranges.push(usageMark.range(e.value.from, e.value.to));
      return Decoration.set(ranges);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Read-only view of the usage's file around its line, the usage marked. */
function UsageCodePreview({ usage }: { usage: Usage | null }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current, state: EditorState.create({ extensions: marks }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  const path = usage?.path ?? null;
  useEffect(() => {
    if (!path) return;
    let alive = true;
    // Debounced so arrowing through the list doesn't load every file.
    const t = setTimeout(() => {
      void Promise.all([readFileLines(path), codePreviewExtensions(path)]).then(([lines, extensions]) => {
        if (!alive || !view.current) return;
        view.current.setState(EditorState.create({ doc: (lines ?? []).join("\n"), extensions: [extensions, marks] }));
        setLoaded(path);
      });
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path]);

  useEffect(() => {
    const v = view.current;
    if (!v || !usage || loaded !== usage.path) return;
    const doc = v.state.doc;
    if (usage.line >= doc.lines) return;
    const line = doc.line(usage.line + 1);
    const from = line.from + Math.min(usage.col, line.length);
    const to = line.from + Math.min(usage.endCol, line.length);
    v.dispatch({ effects: [setMark.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })] });
  }, [usage, loaded]);

  return (
    <div className={styles.preview} role="region" aria-label={tx("Preview")}>
      <div ref={host} className={clsx(styles.previewEditor, loaded !== path && styles.previewHidden)} />
    </div>
  );
}
