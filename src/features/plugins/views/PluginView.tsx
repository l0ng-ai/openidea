/**
 * Renders a plugin's declarative view: the
 * plugin returns data (`View`), this draws it with the workbench's own
 * components and sends the user's actions back (`ViewEvent`). Used by plugin
 * tool windows and custom editors. A refresh comes from the plugin
 * (`viewChanged`), from `revision` (a custom editor's document changed), or
 * from the table scrolling to rows it hasn't got.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import clsx from "clsx";
import type { View, ViewEvent, ViewField, ViewTable, ViewTreeItem, Viewport } from "@/bindings";
import { tx, VerbatimTextContext } from "@/platform/i18n";
import {
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tree,
  showContextMenu,
  type MenuItem,
} from "@/ui";
import { pluginsBackend } from "../backend";
import { subscribeTheme, themeKey } from "@/platform/themeWatch";
import { FRAME_TAG, frameDocument, frameTheme, frameThemeMessage } from "./frame";
import { localizeView, usePluginT } from "../pluginText";
import { currentViewLocation, onViewMessage, useViewLocation, useViewRevision } from "./viewStore";
import { ServicePane } from "./ServicePane";
import styles from "./PluginView.module.css";

export interface PluginViewProps {
  pluginId: string;
  view: string;
  /** The document of a custom editor. */
  doc?: number | null;
  /** Bumped by the owner when the view must render again (document edits). */
  revision?: number;
  /** Called after an event was handled (custom editors re-render on the document instead). */
  label?: string;
  /** Context menu entries by item key (tables use the absolute row index). */
  itemMenu?: (key: string) => MenuItem[];
  /** Show detail-provider tabs beside a tree or list. */
  detail?: boolean;
}

/** Table rows asked for beyond the visible ones (each side). */
const OVERSCAN = 50;
const ROW_HEIGHT = 24;

/** Plugin text is shown as written: the plugin translates it through its own catalog. */
export function PluginView(props: PluginViewProps) {
  const location = useViewLocation();
  return (
    <VerbatimTextContext.Provider value={true}>
      <PluginViewContent key={JSON.stringify([props.pluginId, props.view, props.doc, location])} {...props} />
    </VerbatimTextContext.Provider>
  );
}

function PluginViewContent({
  pluginId,
  view,
  doc = null,
  revision = 0,
  label,
  itemMenu,
  detail = false,
}: PluginViewProps) {
  const [rendered, setContent] = useState<View | null>(null);
  const t = usePluginT(pluginId);
  const content = useMemo(() => rendered && localizeView(rendered, t), [rendered, t]);
  const [error, setError] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const pluginRevision = useViewRevision(pluginId, view);
  const seq = useRef(0);
  const mounted = useRef(true);
  const queue = useRef(Promise.resolve());
  const [selection, setSelection] = useState<{ key: string; after: Promise<unknown> } | null>(null);
  const items = content?.body.kind === "tree" || content?.body.kind === "list" ? content.body.value : null;
  const hasDetail = detail && items !== null;
  const selected = hasDetail && items.some((i) => i.key === selection?.key) ? selection : null;
  const splitId = `plugin-detail-${encodeURIComponent(JSON.stringify([pluginId, view]))}`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!selected) setSelection(null);
  }, [selected]);

  useEffect(() => {
    const mine = ++seq.current;
    pluginsBackend()
      .renderView(pluginId, view, viewport, doc)
      .then(
        (v) => {
          if (mine !== seq.current) return;
          setContent(v);
          setError(null);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setError(e instanceof Error ? e.message : String(e));
        },
      );
    return () => {
      ++seq.current;
    };
  }, [pluginId, view, doc, viewport, revision, pluginRevision]);

  const send = useCallback(
    (event: ViewEvent) => {
      const location = currentViewLocation();
      const pending = queue.current.then(() =>
        mounted.current && location === currentViewLocation()
          ? pluginsBackend().viewEvent(pluginId, view, event, doc)
          : undefined,
      );
      queue.current = pending.catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      });
      if (event.kind === "select") setSelection({ key: event.key, after: pending });
    },
    [pluginId, view, doc],
  );

  if (!content)
    return error ? (
      <EmptyState className={styles.empty} title={tx("The plugin could not show this view")}>
        {error}
      </EmptyState>
    ) : (
      <div className={styles.empty}>
        <Spinner label={tx("Loading")} />
      </div>
    );

  return (
    <div className={styles.view} aria-label={label}>
      {content.toolbar.length > 0 && (
        <div className={styles.toolbar} role="toolbar">
          {content.toolbar.map((b) =>
            b.icon ? (
              <IconButton
                key={b.id}
                icon={b.icon}
                title={b.label}
                disabled={!b.enabled}
                onClick={() => send({ kind: "button", id: b.id })}
              />
            ) : (
              <button
                key={b.id}
                type="button"
                className={styles.textButton}
                disabled={!b.enabled}
                onClick={() => send({ kind: "button", id: b.id })}
              >
                {b.label}
              </button>
            ),
          )}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.body}>
        {hasDetail ? (
          <SplitGroup
            orientation="horizontal"
            storageKey={`openidea.plugins.detailSplit.${JSON.stringify([pluginId, view])}`}
          >
            <SplitPanel id={`${splitId}-items`} defaultSize="40%" minSize="100px">
              <div className={styles.master}>
                <Body
                  content={content}
                  send={send}
                  pluginId={pluginId}
                  view={view}
                  onViewport={setViewport}
                  itemMenu={itemMenu}
                  selectedKey={selected?.key ?? null}
                />
              </div>
            </SplitPanel>
            <SplitHandle />
            <SplitPanel id={`${splitId}-detail`} minSize="100px">
              {selected ? (
                <ServicePane pluginId={pluginId} view={view} itemKey={selected.key} after={selected.after} />
              ) : (
                <EmptyState title={tx("Select an item to view details")} />
              )}
            </SplitPanel>
          </SplitGroup>
        ) : (
          <Body
            content={content}
            send={send}
            pluginId={pluginId}
            view={view}
            onViewport={setViewport}
            itemMenu={itemMenu}
          />
        )}
      </div>
      {content.status && <div className={styles.status}>{content.status}</div>}
    </div>
  );
}

interface BodyProps {
  content: View;
  send: (e: ViewEvent) => void;
  pluginId: string;
  view: string;
  onViewport: (v: Viewport) => void;
  itemMenu?: (key: string) => MenuItem[];
  selectedKey?: string | null;
}

function Body({ content, send, pluginId, view, onViewport, itemMenu, selectedKey }: BodyProps) {
  const body = content.body;
  switch (body.kind) {
    case "message":
      return <EmptyState className={styles.empty} title={body.value} />;
    case "tree":
      return <TreeBody items={body.value} send={send} itemMenu={itemMenu} selectedKey={selectedKey} />;
    case "list":
      return (
        <ul className={styles.list} role="listbox">
          {body.value.map((i) => (
            <li
              key={i.key}
              role="option"
              aria-selected={i.key === selectedKey}
              tabIndex={0}
              className={styles.listItem}
              onClick={() => send({ kind: "select", key: i.key })}
              onDoubleClick={() => send({ kind: "activate", key: i.key })}
              onKeyDown={(e) => {
                if (selectedKey === undefined) {
                  if (e.key === "Enter") send({ kind: "activate", key: i.key });
                  return;
                }
                if (e.key === " ") {
                  e.preventDefault();
                  send({ kind: "select", key: i.key });
                } else if (e.key === "Enter") {
                  send({ kind: "select", key: i.key });
                  send({ kind: "activate", key: i.key });
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const index = body.value.indexOf(i) + (e.key === "ArrowDown" ? 1 : -1);
                  const next = body.value[index];
                  if (next) {
                    (e.currentTarget.parentElement?.children[index] as HTMLElement | undefined)?.focus();
                    send({ kind: "select", key: next.key });
                  }
                }
              }}
              onContextMenu={(e) => openItemMenu(e, itemMenu, i.key)}
            >
              {i.icon && <Icon name={i.icon} size={14} />}
              <span>{i.label}</span>
              {i.detail && <span className={styles.detail}>{i.detail}</span>}
            </li>
          ))}
        </ul>
      );
    case "form":
      return (
        <div className={styles.form}>
          {body.value.map((f) => (
            <FormField key={f.key} field={f} send={send} />
          ))}
        </div>
      );
    case "table":
      return <TableBody table={body.value} send={send} onViewport={onViewport} itemMenu={itemMenu} />;
    case "html":
      return <HtmlBody html={body.value} send={send} pluginId={pluginId} view={view} />;
  }
}

// --- tree -------------------------------------------------------------------------

export interface TreeNode {
  item: ViewTreeItem;
  children: TreeNode[];
}

/** The flat item list as nodes (items naming an unknown parent are roots). */
export function treeNodes(items: readonly ViewTreeItem[]): TreeNode[] {
  const byKey = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const item of items) {
    const node: TreeNode = { item, children: [] };
    if (!byKey.has(item.key)) byKey.set(item.key, node);
    const parent = item.parent != null ? byKey.get(item.parent) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

function openItemMenu(
  e: ReactMouseEvent | MouseEvent,
  itemMenu: ((key: string) => MenuItem[]) | undefined,
  key: string,
) {
  const items = itemMenu?.(key) ?? [];
  if (items.length === 0) return;
  e.preventDefault();
  showContextMenu(e, items);
}

interface TreeBodyProps {
  items: ViewTreeItem[];
  send: (e: ViewEvent) => void;
  itemMenu?: (key: string) => MenuItem[];
  selectedKey?: string | null;
}

function TreeBody({ items, send, itemMenu, selectedKey }: TreeBodyProps) {
  const roots = useMemo(() => treeNodes(items), [items]);
  const expanded = useMemo(() => new Set(items.filter((i) => i.expanded).map((i) => i.key)), [items]);
  return (
    <Tree<TreeNode>
      roots={roots}
      getKey={(n) => n.item.key}
      getLabel={(n) => n.item.label}
      getChildren={(n) => (n.children.length ? n.children : n.item.expandable ? undefined : [])}
      isExpandable={(n) => n.item.expandable || n.children.length > 0}
      getIcon={(n) => n.item.icon ?? undefined}
      getDetail={(n) => n.item.detail ?? undefined}
      expanded={expanded}
      selected={selectedKey === undefined ? undefined : new Set(selectedKey === null ? [] : [selectedKey])}
      onExpandedChange={(_, node, isExpanded) =>
        send(isExpanded ? { kind: "expand", key: node.item.key } : { kind: "collapse", key: node.item.key })
      }
      onSelectionChange={(_, lead) => lead && send({ kind: "select", key: lead.item.key })}
      onActivate={(n) => send({ kind: "activate", key: n.item.key })}
      multiSelect={false}
      onContextMenu={itemMenu ? (node, _, e) => node && openItemMenu(e, itemMenu, node.item.key) : undefined}
    />
  );
}

// --- form -------------------------------------------------------------------------

function FormField({ field, send }: { field: ViewField; send: (e: ViewEvent) => void }) {
  const commit = (value: string) => send({ kind: "field", key: field.key, value });
  const v = field.value;
  const id = `plugin-field-${field.key}`;
  return (
    <div className={styles.field}>
      {v.kind !== "checkbox" && (
        <label className={styles.fieldLabel} htmlFor={id}>
          {field.label}
        </label>
      )}
      {v.kind === "label" && (
        <output id={id} className={styles.readonlyValue}>
          {v.value}
        </output>
      )}
      {v.kind === "readonlyText" &&
        (v.value.multiline ? (
          <textarea id={id} className={clsx(styles.textarea, styles.readonlyField)} value={v.value.text} readOnly />
        ) : (
          <Input id={id} className={styles.readonlyField} value={v.value.text} readOnly />
        ))}
      {v.kind === "text" && <TextField id={id} initial={v.value} onCommit={commit} />}
      {v.kind === "multiline" && <TextField id={id} initial={v.value} onCommit={commit} multiline />}
      {v.kind === "checkbox" && (
        <Checkbox checked={v.value} label={field.label} onChange={(on) => commit(on ? "true" : "false")} />
      )}
      {v.kind === "choice" && (
        <Select
          aria-label={field.label}
          value={v.value.selected}
          options={v.value.options.map((o) => ({ value: o, label: o }))}
          onChange={commit}
        />
      )}
    </div>
  );
}

function TextField({
  id,
  initial,
  onCommit,
  multiline,
}: {
  id: string;
  initial: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const commit = () => value !== initial && onCommit(value);
  return multiline ? (
    <textarea
      id={id}
      className={styles.textarea}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
    />
  ) : (
    <Input
      id={id}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

// --- table ------------------------------------------------------------------------

/** The rows to ask for when `first..first + visible` is shown. */
export function wantedViewport(first: number, visible: number, total: number): Viewport {
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(total, first + visible + OVERSCAN);
  return { firstRow: start, rows: Math.max(0, end - start) };
}

function TableBody({
  table,
  send,
  onViewport,
  itemMenu,
}: {
  table: ViewTable;
  send: (e: ViewEvent) => void;
  onViewport: (v: Viewport) => void;
  itemMenu?: (key: string) => MenuItem[];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 400));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const first = Math.floor(scrollTop / ROW_HEIGHT);
  const visible = Math.ceil(height / ROW_HEIGHT) + 1;
  const loadedEnd = table.firstRow + table.rows.length;
  const shownEnd = Math.min(table.totalRows, first + visible);
  // Ask for rows the scroll position shows but the last render didn't include.
  useEffect(() => {
    if (first < table.firstRow || shownEnd > loadedEnd) onViewport(wantedViewport(first, visible, table.totalRows));
  }, [first, visible, shownEnd, loadedEnd, table.firstRow, table.totalRows, onViewport]);

  const rowMenu = (row: number, e: ReactMouseEvent | ReactKeyboardEvent) => {
    e.preventDefault();
    const rows = selected.has(row) ? [...selected].sort((a, b) => a - b) : [row];
    if (!selected.has(row)) {
      setSelected(new Set([row]));
      send({ kind: "tableSelect", row });
    }
    const items: MenuItem[] = [
      { label: tx("Insert Row Above"), icon: "plus", run: () => send({ kind: "insertRow", before: row }) },
      { label: tx("Insert Row Below"), run: () => send({ kind: "insertRow", before: row + 1 }) },
      { kind: "separator" },
      {
        label: rows.length > 1 ? tx`Delete ${rows.length} Rows` : tx("Delete Row"),
        icon: "trash",
        danger: true,
        run: () => send({ kind: "deleteRows", rows }),
      },
    ];
    const contributed = itemMenu?.(String(row)) ?? [];
    const menu = table.editable
      ? [...contributed, ...(contributed.length ? [{ kind: "separator" } as const] : []), ...items]
      : contributed;
    if (menu.length) {
      const rect = e.currentTarget.getBoundingClientRect();
      showContextMenu("clientX" in e ? e : { x: rect.left, y: rect.bottom }, menu);
    }
  };

  // A sortable table (`table` through the plugin API's `other` body case):
  // the plugin sorts its own rows, so a header click only asks it to — the
  // first click ascending, a second on the same column reversed.
  const sort = table.sortable ? table.sort : null;
  const sortColumn = (column: number) =>
    send({ kind: "sort", column, descending: sort?.column === column ? !sort.descending : false });

  const rows: React.ReactNode[] = [];
  for (let r = Math.max(first, table.firstRow); r < Math.min(shownEnd, loadedEnd); r++) {
    const cells = table.rows[r - table.firstRow] ?? [];
    rows.push(
      <div
        key={r}
        role="row"
        aria-rowindex={r + 2}
        aria-selected={selected.has(r)}
        className={styles.tableRow}
        style={{ top: (r + 1) * ROW_HEIGHT }}
        tabIndex={0}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("input, textarea")) return;
          setSelected((s) => {
            if (!(e.metaKey || e.ctrlKey)) return new Set([r]);
            const next = new Set(s);
            if (next.has(r)) next.delete(r);
            else next.add(r);
            return next;
          });
          send({ kind: "tableSelect", row: r });
        }}
        onDoubleClick={(e) => {
          if (!table.editable || (e.target as HTMLElement).closest('[role="rowheader"]'))
            send({ kind: "tableActivate", row: r });
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter") {
            e.preventDefault();
            send({ kind: "tableActivate", row: r });
          } else if (e.key === " ") {
            e.preventDefault();
            setSelected(new Set([r]));
            send({ kind: "tableSelect", row: r });
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            rowMenu(r, e);
          }
        }}
        onContextMenu={(e) => rowMenu(r, e)}
      >
        <div className={styles.rowNumber} role="rowheader">
          {r + 1}
        </div>
        {table.columns.map((_, c) => (
          <div
            key={c}
            role="gridcell"
            className={styles.cell}
            title={cells[c]}
            onDoubleClick={() => table.editable && setEditing({ row: r, column: c })}
          >
            {editing?.row === r && editing.column === c ? (
              <CellEditor
                initial={cells[c] ?? ""}
                onDone={(value) => {
                  setEditing(null);
                  if (value !== null && value !== (cells[c] ?? "")) send({ kind: "cell", row: r, column: c, value });
                }}
              />
            ) : (
              cells[c]
            )}
          </div>
        ))}
      </div>,
    );
  }

  return (
    <div
      ref={scroller}
      className={styles.tableScroller}
      role="grid"
      aria-rowcount={table.totalRows + 1}
      aria-colcount={table.columns.length}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div className={styles.tableCanvas} style={{ height: (table.totalRows + 1) * ROW_HEIGHT }}>
        <div className={`${styles.tableRow} ${styles.tableHeader}`} role="row" aria-rowindex={1}>
          <div className={styles.rowNumber} />
          {table.columns.map((c, i) => {
            const sorted = sort?.column === i;
            return (
              <div
                key={i}
                role="columnheader"
                className={table.sortable ? `${styles.cell} ${styles.headerCell}` : styles.cell}
                title={c}
                aria-sort={sorted ? (sort.descending ? "descending" : "ascending") : undefined}
                tabIndex={table.sortable ? 0 : undefined}
                onClick={table.sortable ? () => sortColumn(i) : undefined}
                onKeyDown={
                  table.sortable
                    ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), sortColumn(i))
                    : undefined
                }
              >
                {c}
                {sorted && (
                  <Icon name={sort.descending ? "chevron-down" : "chevron-up"} size={12} className={styles.sortIcon} />
                )}
              </div>
            );
          })}
        </div>
        {rows}
      </div>
      {table.totalRows === 0 && <div className={styles.tableEmpty}>{tx("No rows")}</div>}
    </div>
  );
}

function CellEditor({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") finish(value);
    else if (e.key === "Escape") finish(null);
  };
  return (
    <Input
      autoFocus
      variant="bare"
      aria-label={tx("Cell value")}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(value)}
    />
  );
}

// --- html -------------------------------------------------------------------------

function HtmlBody({
  html,
  send,
  pluginId,
  view,
}: {
  html: string;
  send: (e: ViewEvent) => void;
  pluginId: string;
  view: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The theme at load time is in the document; later changes are posted, so a
  // theme switch doesn't reload the frame and lose its state.
  const srcDoc = useMemo(() => frameDocument(html, frameTheme()), [html]);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  const postTheme = useCallback(
    () => frame.current?.contentWindow?.postMessage(frameThemeMessage(frameTheme()), "*"),
    [],
  );
  useEffect(postTheme, [theme, postTheme]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const data = e.data as { tag?: unknown; text?: unknown } | null;
      if (data?.tag === FRAME_TAG && typeof data.text === "string") send({ kind: "message", text: data.text });
    };
    window.addEventListener("message", onMessage);
    const off = onViewMessage(pluginId, view, (text) =>
      frame.current?.contentWindow?.postMessage({ tag: FRAME_TAG, text }, "*"),
    );
    return () => {
      window.removeEventListener("message", onMessage);
      off();
    };
  }, [pluginId, view, send]);

  // No `allow-same-origin`: an opaque origin without access to the IDE.
  // `onLoad` re-sends the theme in case it changed between building `srcDoc` and the frame loading.
  return (
    <iframe
      ref={frame}
      className={styles.frame}
      title={view}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      onLoad={postTheme}
    />
  );
}
