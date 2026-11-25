/**
 * The ER diagram of Diagrams › Show Diagram (IDEA's Database diagram), in an
 * editor tab or the Show Diagram popup: ELK lays the tables out; tables drag,
 * collapse to their header, hide, and jump to the Database tree; the view pans
 * and zooms; the arrangement is saved per set of tables.
 */
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import clsx from "clsx";
import { Dialog, Icon, IconButton, Toolbar, showContextMenu, type MenuItem } from "@/ui";
import { tx } from "@/platform/i18n";
import { isMacHost } from "@/platform/keymap";
import { fontsLoaded } from "@/platform/fonts";
import { resolveTokenColor, toRgb } from "@/platform/cssColor";
import type { EditorInput } from "@/workbench/contributions";
import { fitZoom, stepZoom, clampZoom, zoomAt, zoomLabel, type View } from "@/features/viewers/imageZoom";
import { saveDiagram } from "@/features/viewers/markdown/mermaidTools";
import { closeDialog, revealInTree } from "./store";
import { diagramKey, diagramModel, type DiagramData, type DiagramNode } from "./erDiagram";
import {
  BADGE,
  GAP,
  HEADER_HEIGHT,
  ICON,
  PAD,
  ROW_HEIGHT,
  autoLayout,
  linkPath,
  loadLayout,
  rowCenter,
  saveLayout,
  tableSize,
  type Box,
  type Measure,
  type Point,
} from "./diagramLayout";
import styles from "./Diagram.module.css";

/** Margin around the tables when the view fits them, and around an exported image. */
const MARGIN = 24;

interface Arrangement {
  positions: ReadonlyMap<string, Point>;
  hidden: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
}

let context: CanvasRenderingContext2D | null | undefined;

/** Text widths in the diagram's font (`--font-ui` at the small size), as the theme sets it now. */
function measurer(): Measure {
  context ??= document.createElement("canvas").getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const font = `${css.getPropertyValue("--fs-small").trim() || "12px"} ${css.getPropertyValue("--font-ui").trim() || "sans-serif"}`;
  return (text, bold) => {
    if (!context) return text.length * 7;
    context.font = bold ? `600 ${font}` : font;
    return context.measureText(text).width;
  };
}

/** `set` with `keys` added (`on`) or removed. */
function toggle(set: ReadonlySet<string>, keys: readonly string[], on: boolean): Set<string> {
  const next = new Set(set);
  for (const k of keys) {
    if (on) next.add(k);
    else next.delete(k);
  }
  return next;
}

function movedBy(a: Arrangement, from: ReadonlyMap<string, Point>, dx: number, dy: number): Arrangement {
  const positions = new Map(a.positions);
  for (const [k, p] of from) positions.set(k, { x: p.x + dx, y: p.y + dy });
  return { ...a, positions };
}

const bounds = (boxes: readonly Box[]): Box | null => {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
    h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
  };
};

export function DiagramView({ data, onJump }: { data: DiagramData; onJump?: () => void }) {
  const key = useMemo(() => diagramKey(data.tables), [data.tables]);
  const { nodes, edges } = useMemo(() => diagramModel(data.tables), [data.tables]);
  const [arrangement, setArrangement] = useState<Arrangement | null>(null);
  const [view, setView] = useState<View>({ z: 1, x: MARGIN, y: MARGIN });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [panning, setPanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const content = useRef<SVGGElement>(null);
  const markerId = `db-diagram-arrow${useId().replace(/[^\w-]/g, "")}`;

  const sizes = useMemo(() => {
    const collapsed = arrangement?.collapsed;
    const measure = measurer();
    return new Map(nodes.map((n) => [n.key, tableSize(n, !!collapsed?.has(n.key), measure)]));
  }, [nodes, arrangement?.collapsed]);
  const boxOf = (k: string): Box | null => {
    const p = arrangement?.positions.get(k);
    const s = sizes.get(k);
    return p && s ? { ...p, ...s } : null;
  };
  const shown = nodes.filter((n) => !arrangement?.hidden.has(n.key) && boxOf(n.key));

  /** Zooms out (never in past 100%) and scrolls so that the shown tables of `a` fill the view. */
  const fit = useCallback(
    (a: Arrangement) => {
      const el = canvas.current;
      const measure = measurer();
      const b = bounds(
        nodes.flatMap((n) => {
          const p = a.positions.get(n.key);
          return p && !a.hidden.has(n.key) ? [{ ...p, ...tableSize(n, a.collapsed.has(n.key), measure) }] : [];
        }),
      );
      if (!el || !b) return;
      const z = Math.min(1, fitZoom(b.w, b.h, el.clientWidth - 2 * MARGIN, el.clientHeight - 2 * MARGIN));
      setView({
        z,
        x: (el.clientWidth - b.w * z) / 2 - b.x * z,
        y: Math.max(MARGIN, (el.clientHeight - b.h * z) / 2) - b.y * z,
      });
    },
    [nodes],
  );

  const relayout = useCallback(
    async (hidden: ReadonlySet<string>, collapsed: ReadonlySet<string>, previous?: ReadonlyMap<string, Point>) => {
      // Boxes measured before the UI font loads would stay too narrow.
      const css = getComputedStyle(document.documentElement);
      await fontsLoaded(css.getPropertyValue("--font-ui").trim() || "sans-serif", 12);
      const measure = measurer();
      const visible = nodes.filter((n) => !hidden.has(n.key));
      const placed = await autoLayout(
        visible.map((n) => ({ key: n.key, ...tableSize(n, collapsed.has(n.key), measure) })),
        edges
          .map((e) => ({ from: nodes[e.from]!.key, to: nodes[e.to]!.key }))
          .filter((l) => !hidden.has(l.from) && !hidden.has(l.to)),
      );
      // Hidden tables keep their place, to come back to it when shown again.
      return { positions: new Map([...(previous ?? []), ...placed]), hidden, collapsed };
    },
    [nodes, edges],
  );

  // A saved arrangement when it places every table, else a fresh layout.
  useEffect(() => {
    let live = true;
    const saved = loadLayout(key);
    const known = new Set(nodes.map((n) => n.key));
    const hidden = new Set(saved?.hidden.filter((k) => known.has(k)));
    const collapsed = new Set(saved?.collapsed.filter((k) => known.has(k)));
    const ready = (a: Arrangement) => {
      if (!live) return;
      setArrangement(a);
      requestAnimationFrame(() => live && fit(a));
    };
    if (saved && nodes.every((n) => saved.positions[n.key]))
      ready({ positions: new Map(Object.entries(saved.positions)), hidden, collapsed });
    else relayout(hidden, collapsed).then(ready, (e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [key, nodes, relayout, fit]);

  const update = (next: Arrangement) => {
    setArrangement(next);
    saveLayout(key, {
      positions: Object.fromEntries(next.positions),
      hidden: [...next.hidden],
      collapsed: [...next.collapsed],
    });
  };
  /** The tables an action on `k` applies to: the selection when `k` is part of it. */
  const targets = (k: string) => (selected.has(k) ? [...selected] : [k]);
  const collapse = (keys: readonly string[], on: boolean) =>
    arrangement && update({ ...arrangement, collapsed: toggle(arrangement.collapsed, keys, on) });
  const hide = (keys: readonly string[]) => {
    if (!arrangement) return;
    update({ ...arrangement, hidden: toggle(arrangement.hidden, keys, true) });
    setSelected(new Set());
  };
  const jump = (node: DiagramNode, column?: string) => {
    const t = node.table;
    void revealInTree(t.id, t.schema, t.name, undefined, column);
    onJump?.();
  };
  const showHidden = () => arrangement && update({ ...arrangement, hidden: new Set() });
  const applyLayout = () => {
    if (!arrangement) return;
    relayout(arrangement.hidden, arrangement.collapsed, arrangement.positions).then(
      (next) => {
        update(next);
        fit(next);
      },
      (e: unknown) => setError(String(e)),
    );
  };
  const exportImage = () => {
    const g = content.current;
    const b = bounds(shown.flatMap((n) => boxOf(n.key) ?? []));
    if (g && b) void saveDiagram(standaloneSvg(g, b), data.title, ["png", "svg"]);
  };

  const zoomTo = (z: (current: number) => number) => {
    const el = canvas.current;
    if (el) setView((v) => zoomAt(v, z(v.z), el.clientWidth / 2, el.clientHeight / 2));
  };

  // Native listener: React's wheel handler is passive. ⌘/Ctrl+wheel zooms at the pointer, a plain wheel pans.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        const r = el.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 0 ? 0.01 : 0.33));
        setView((v) => zoomAt(v, clampZoom(v.z * factor), e.clientX - r.left, e.clientY - r.top));
      } else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    /** The tables moved and where they started; none for a pan. */
    from: ReadonlyMap<string, Point>;
    /** Distance dragged, in diagram units. */
    dx: number;
    dy: number;
    moved: boolean;
    /** A plain click on a table of a larger selection selects only it, unless it drags. */
    only?: string;
  } | null>(null);

  const nodeAt = (target: EventTarget) => {
    const table = (target as Element).closest<SVGElement>("[data-table]");
    return table ? nodes[Number(table.dataset.table)] : undefined;
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    // A Control-click on macOS opens the context menu.
    if (e.button !== 0 || (e.ctrlKey && isMacHost()) || !arrangement) return;
    const k = nodeAt(e.target)?.key;
    if ((e.target as Element).closest("[data-toggle]") && k) {
      collapse([k], !arrangement.collapsed.has(k));
      return;
    }
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    let moving: ReadonlySet<string> = new Set();
    if (k) {
      moving = additive ? toggle(selected, [k], !selected.has(k)) : selected.has(k) ? selected : new Set([k]);
      setSelected(moving);
      if (!moving.has(k)) moving = new Set();
    } else {
      if (!additive) setSelected(new Set());
      setPanning(true);
    }
    const from = new Map(
      [...moving].flatMap((s) => {
        const p = arrangement.positions.get(s);
        return p ? [[s, p] as const] : [];
      }),
    );
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from,
      dx: 0,
      dy: 0,
      moved: false,
      only: k && !additive && selected.size > 1 ? k : undefined,
    };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    // Captured only once it drags: a capture from the press would retarget a double-click to the canvas.
    if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
    d.moved = true;
    if (!d.from.size) {
      d.x = e.clientX;
      d.y = e.clientY;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      return;
    }
    [d.dx, d.dy] = [dx / view.z, dy / view.z];
    setArrangement((a) => a && movedBy(a, d.from, d.dx, d.dy));
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setPanning(false);
    // Only the dragged tables move during a drag: their final places complete any arrangement of this render.
    if (d.moved && d.from.size && arrangement) update(movedBy(arrangement, d.from, d.dx, d.dy));
    else if (!d.moved && d.only) setSelected(new Set([d.only]));
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    const node = nodeAt(e.target);
    if (!node || (e.target as Element).closest("[data-toggle]")) return;
    jump(node, (e.target as Element).closest<SVGElement>("[data-column]")?.dataset.column);
  };
  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (!arrangement) return;
    const node = nodeAt(e.target);
    const items: MenuItem[] = [];
    if (node) {
      const k = node.key;
      if (!selected.has(k)) setSelected(new Set([k]));
      const keys = targets(k);
      const expand = keys.every((t) => arrangement.collapsed.has(t));
      items.push(
        { label: "Jump to Source", icon: "edit-source", shortcut: "F4", run: () => jump(node) },
        { kind: "separator" },
        { label: expand ? "Expand" : "Collapse", run: () => collapse(keys, !expand) },
        { label: "Hide", icon: "hide", run: () => hide(keys) },
      );
    } else {
      items.push(
        {
          label: "Show Hidden Tables",
          icon: "eye",
          disabled: !arrangement.hidden.size,
          run: showHidden,
        },
        { label: "Apply Layout", icon: "layout", run: applyLayout },
        { kind: "separator" },
        { label: "Export to Image…", icon: "download", run: exportImage },
      );
    }
    showContextMenu(e, items);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Enter on a toolbar button presses the button.
    if (e.target !== e.currentTarget) return;
    const lead = nodes.find((n) => n.key === [...selected].at(-1));
    if ((e.key === "Enter" || e.key === "F4") && lead) {
      e.preventDefault();
      jump(lead);
    } else if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(new Set(shown.map((n) => n.key)));
    }
  };

  const message = error ? tx`Cannot lay out the diagram: ${error}` : !arrangement && tx("Laying out the tables…");
  const anyExpanded = shown.some((n) => !arrangement?.collapsed.has(n.key));
  return (
    <div className={styles.root} tabIndex={0} onKeyDown={onKeyDown} aria-label={data.title}>
      <Toolbar className={styles.toolbar} aria-label="Diagram actions">
        <IconButton icon="zoom-in" size="small" title="Zoom In" onClick={() => zoomTo((z) => stepZoom(z, 1))} />
        <IconButton icon="zoom-out" size="small" title="Zoom Out" onClick={() => zoomTo((z) => stepZoom(z, -1))} />
        <IconButton icon="actual-size" size="small" title="Actual Size" onClick={() => zoomTo(() => 1)} />
        <IconButton icon="maximize" size="small" title="Fit Content" onClick={() => arrangement && fit(arrangement)} />
        <span className={styles.separator} />
        <IconButton icon="layout" size="small" title="Apply Layout" disabled={!arrangement} onClick={applyLayout} />
        <IconButton
          icon={anyExpanded ? "collapse-all" : "expand-all"}
          size="small"
          title={anyExpanded ? "Collapse All" : "Expand All"}
          disabled={!arrangement}
          onClick={() =>
            collapse(
              shown.map((n) => n.key),
              anyExpanded,
            )
          }
        />
        <IconButton
          icon="eye"
          size="small"
          title="Show Hidden Tables"
          disabled={!arrangement?.hidden.size}
          onClick={showHidden}
        />
        <span className={styles.separator} />
        <IconButton
          icon="download"
          size="small"
          title="Export to Image…"
          disabled={!arrangement}
          onClick={exportImage}
        />
        <span className={styles.zoom}>{zoomLabel(view.z)}</span>
      </Toolbar>
      <div
        ref={canvas}
        className={clsx(styles.canvas, panning && styles.panning)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        {message && <div className={styles.message}>{message}</div>}
        <svg role="group" aria-label={data.title}>
          <g ref={content} transform={`translate(${view.x} ${view.y}) scale(${view.z})`}>
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path className={styles.arrow} d="M0,0L10,5L0,10z" />
              </marker>
            </defs>
            {arrangement &&
              edges.map((e, i) => {
                const [from, to] = [nodes[e.from]!, nodes[e.to]!];
                const [a, b] = [boxOf(from.key), boxOf(to.key)];
                if (!a || !b || arrangement.hidden.has(from.key) || arrangement.hidden.has(to.key)) return null;
                const fromY = rowCenter(from, a, arrangement.collapsed.has(from.key), e.fromColumns[0]);
                const toY = rowCenter(to, b, arrangement.collapsed.has(to.key), e.toColumns[0]);
                return (
                  <path
                    key={i}
                    className={clsx(styles.link, e.optional && styles.optional)}
                    d={linkPath(a, fromY, b, toY)}
                    markerEnd={`url(#${markerId})`}
                  >
                    <title>{`${from.label} (${e.fromColumns.join(", ")}) → ${to.label} (${e.toColumns.join(", ")})`}</title>
                  </path>
                );
              })}
            {nodes.map((n, i) => {
              const b = boxOf(n.key);
              if (!b || arrangement?.hidden.has(n.key)) return null;
              return (
                <TableBox
                  key={n.key}
                  index={i}
                  node={n}
                  {...b}
                  collapsed={!!arrangement?.collapsed.has(n.key)}
                  selected={selected.has(n.key)}
                />
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

const TableBox = memo(function TableBox({
  index,
  node,
  x,
  y,
  w,
  h,
  collapsed,
  selected,
}: {
  /** In the diagram's nodes, for the pointer handlers: a table's key may hold characters an attribute can't. */
  index: number;
  node: DiagramNode;
  collapsed: boolean;
  selected: boolean;
} & Box) {
  return (
    <g className={styles.table} transform={`translate(${x} ${y})`} data-table={index} aria-label={node.label}>
      <rect className={styles.body} width={w} height={h} rx={4} />
      <path
        className={styles.header}
        d={`M0.5,${HEADER_HEIGHT}V4.5a4,4 0 0 1 4,-4H${w - 4.5}a4,4 0 0 1 4,4V${HEADER_HEIGHT}Z`}
      />
      <g transform={`translate(${PAD} ${(HEADER_HEIGHT - ICON) / 2})`}>
        <Icon name="db-table" size={ICON} />
      </g>
      <text className={styles.title} x={PAD + ICON + GAP} y={HEADER_HEIGHT / 2} dominantBaseline="central">
        {node.label}
      </text>
      <g
        className={styles.toggle}
        data-toggle=""
        transform={`translate(${w - PAD - ICON} ${(HEADER_HEIGHT - ICON) / 2})`}
        role="button"
        aria-label={tx(collapsed ? "Expand" : "Collapse")}
        aria-expanded={!collapsed}
      >
        <rect width={ICON} height={ICON} rx={3} />
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={ICON} />
      </g>
      {!collapsed &&
        node.columns.map((c, i) => {
          const top = HEADER_HEIGHT + i * ROW_HEIGHT;
          const marks = [c.indexed && "IX", c.unique && "UK"].filter((m): m is string => !!m);
          return (
            <g key={c.name || i} data-column={c.name} transform={`translate(0 ${top})`}>
              {c.indexes.length > 0 && <title>{c.indexes.join(", ")}</title>}
              <g transform={`translate(${PAD} ${(ROW_HEIGHT - ICON) / 2})`}>
                <Icon name={c.primaryKey ? "db-column-key" : c.foreignKey ? "db-column-fk" : "db-column"} size={ICON} />
              </g>
              <text className={styles.name} x={PAD + ICON + GAP} y={ROW_HEIGHT / 2} dominantBaseline="central">
                {c.name}
              </text>
              <text
                className={styles.type}
                x={w - PAD - marks.length * BADGE}
                y={ROW_HEIGHT / 2}
                dominantBaseline="central"
                textAnchor="end"
              >
                {c.type}
              </text>
              {marks.map((m, j) => (
                <text
                  key={m}
                  className={styles.badge}
                  x={w - PAD - (marks.length - 1 - j) * BADGE}
                  y={ROW_HEIGHT / 2}
                  dominantBaseline="central"
                  textAnchor="end"
                  data-mark={m}
                >
                  {m}
                </text>
              ))}
            </g>
          );
        })}
      {selected && (
        <rect className={styles.selection} data-selection="" x={-2} y={-2} width={w + 4} height={h + 4} rx={5} />
      )}
    </g>
  );
});

/**
 * A copy of the diagram's tables and links as a standalone SVG around `b`: on
 * the editor background, with the theme's colours and fonts written into each
 * element, and without the selection.
 */
function standaloneSvg(g: SVGGElement, b: Box): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const [w, h] = [Math.ceil(b.w + 2 * MARGIN), Math.ceil(b.h + 2 * MARGIN)];
  svg.setAttribute("xmlns", ns);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `${b.x - MARGIN} ${b.y - MARGIN} ${w} ${h}`);
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("x", String(b.x - MARGIN));
  background.setAttribute("y", String(b.y - MARGIN));
  background.setAttribute("width", String(w));
  background.setAttribute("height", String(h));
  const editor = resolveTokenColor("--bg-editor") ?? resolveTokenColor("--bg-app");
  if (editor) background.setAttribute("fill", toRgb(editor));
  const copy = g.cloneNode(true) as SVGGElement;
  copy.removeAttribute("transform");
  inlineStyles(g, copy);
  for (const s of copy.querySelectorAll("[data-selection]")) s.remove();
  // XML has no place for control characters a name may hold.
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) t.nodeValue = t.nodeValue!.replace(CONTROL, "");
  for (const el of copy.querySelectorAll("[data-column], [aria-label]")) {
    el.removeAttribute("data-column");
    el.removeAttribute("aria-label");
  }
  svg.append(background, copy);
  return svg;
}

const INLINED = ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight"];

// oxlint-disable-next-line no-control-regex -- the characters XML 1.0 can't hold
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Writes `from`'s computed look into its copy `to`, dropping what CSS hides (an icon's other-theme variant). */
function inlineStyles(from: Element, to: Element) {
  const css = getComputedStyle(from);
  if (css.display === "none") {
    to.remove();
    return;
  }
  for (const p of INLINED) {
    const v = css.getPropertyValue(p);
    if (v) (to as SVGElement).style.setProperty(p, v);
  }
  to.removeAttribute("class");
  // Backwards: a removed child doesn't shift the ones still to visit.
  for (let i = from.children.length - 1; i >= 0; i--) inlineStyles(from.children[i]!, to.children[i]!);
}

/** The tab Diagrams › Show Diagram opens. */
export function DiagramEditor({ input }: { input: EditorInput }) {
  return <DiagramView data={input.data as DiagramData} />;
}

/** Diagrams › Show Diagram Popup (IDEA `ShowUmlDiagramPopup`): the diagram over the window; Escape closes it. */
export function DiagramPopup({ data }: { data: DiagramData }) {
  const jumped = useRef(false);
  return (
    <Dialog
      open
      popup
      onClose={closeDialog}
      title={data.title}
      resizable="both"
      initialSize={{ w: 900, h: 600 }}
      minWidth={360}
      minHeight={240}
      dismissOnBackdrop
      className={styles.popup}
      restoreFocus={() => !jumped.current}
    >
      <DiagramView
        data={data}
        onJump={() => {
          jumped.current = true;
          closeDialog();
        }}
      />
    </Dialog>
  );
}
