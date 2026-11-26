/** Geometry of the ER diagram: table sizes, the automatic layout, link routes and the saved layout. */
import type { DiagramNode } from "./erDiagram";

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  w: number;
  h: number;
}

export const HEADER_HEIGHT = 28;
export const ROW_HEIGHT = 22;
export const PAD = 8;
export const ICON = 16;
export const GAP = 6;
/** Width of a `UK` / `IX` marker after a column's type. */
export const BADGE = 22;
const MIN_WIDTH = 140;
/** Room between a column's name and its type. */
const NAME_TYPE_GAP = 20;
/** How far a link leaves a table before it turns. */
const STUB = 24;

export type Measure = (text: string, bold?: boolean) => number;

const badges = (c: DiagramNode["columns"][number]) => (c.unique ? 1 : 0) + (c.indexed ? 1 : 0);

/** The table's size: its header alone when collapsed. */
export function tableSize(node: DiagramNode, collapsed: boolean, measure: Measure): { w: number; h: number } {
  const header = PAD + ICON + GAP + measure(node.label, true) + GAP + ICON + PAD;
  const rows = node.columns.map(
    (c) => PAD + ICON + GAP + measure(c.name) + NAME_TYPE_GAP + measure(c.type) + badges(c) * BADGE + PAD,
  );
  return {
    w: Math.ceil(Math.max(MIN_WIDTH, header, ...rows)),
    h: HEADER_HEIGHT + (collapsed ? 0 : node.columns.length * ROW_HEIGHT),
  };
}

/** Vertical centre of `column`'s row, or of the header when the column isn't shown. */
export function rowCenter(node: DiagramNode, box: Box, collapsed: boolean, column: string | undefined): number {
  const i = collapsed || column === undefined ? -1 : node.columns.findIndex((c) => c.name === column);
  return box.y + (i < 0 ? HEADER_HEIGHT / 2 : HEADER_HEIGHT + i * ROW_HEIGHT + ROW_HEIGHT / 2);
}

/**
 * An orthogonal link from the row at `fromY` of `from` to the row at `toY` of
 * `to`: between facing sides when the tables are apart, around the right side
 * when they overlap horizontally or are the same table.
 */
export function linkPath(from: Box, fromY: number, to: Box, toY: number): string {
  if (from.x + from.w + STUB <= to.x) {
    const mid = (from.x + from.w + to.x) / 2;
    return `M${from.x + from.w},${fromY}H${mid}V${toY}H${to.x}`;
  }
  if (to.x + to.w + STUB <= from.x) {
    const mid = (to.x + to.w + from.x) / 2;
    return `M${from.x},${fromY}H${mid}V${toY}H${to.x + to.w}`;
  }
  const out = Math.max(from.x + from.w, to.x + to.w) + STUB;
  return `M${from.x + from.w},${fromY}H${out}V${toY}H${to.x + to.w}`;
}

/** Spacing between tables, and between groups of tables not linked to each other. */
const LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "40",
  "elk.layered.spacing.nodeNodeBetweenLayers": "80",
  "elk.spacing.componentComponent": "60",
};

/** Positions of `boxes` laid out by ELK's layered algorithm, referenced tables left of their referencing ones. */
export async function autoLayout(
  boxes: ReadonlyArray<{ key: string; w: number; h: number }>,
  links: ReadonlyArray<{ from: string; to: string }>,
): Promise<Map<string, Point>> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const graph = await new ELK().layout({
    id: "root",
    layoutOptions: LAYOUT_OPTIONS,
    children: boxes.map((b) => ({ id: b.key, width: b.w, height: b.h })),
    edges: links.filter((l) => l.from !== l.to).map((l, i) => ({ id: `e${i}`, sources: [l.to], targets: [l.from] })),
  });
  return new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

/** What a diagram remembers between openings. */
interface SavedLayout {
  positions: Record<string, Point>;
  hidden: string[];
  collapsed: string[];
}

const LAYOUTS_KEY = "openidea.database.diagrams";
/** Diagrams remembered at most; the least recently saved goes first. */
const SAVED_LAYOUTS = 50;

function savedLayouts(): Array<[string, SavedLayout]> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUTS_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter(
          (e): e is [string, SavedLayout] =>
            Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "object" && e[1] !== null,
        )
      : [];
  } catch {
    return [];
  }
}

export function loadLayout(key: string): SavedLayout | null {
  const saved = savedLayouts().find(([k]) => k === key)?.[1];
  if (!saved || typeof saved.positions !== "object" || !saved.positions) return null;
  const point = (p: unknown): p is Point =>
    typeof p === "object" && p !== null && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y);
  return {
    positions: Object.fromEntries(Object.entries(saved.positions).filter(([, p]) => point(p))),
    hidden: Array.isArray(saved.hidden) ? saved.hidden : [],
    collapsed: Array.isArray(saved.collapsed) ? saved.collapsed : [],
  };
}

export function saveLayout(key: string, layout: SavedLayout): void {
  const rest = savedLayouts().filter(([k]) => k !== key);
  try {
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify([...rest, [key, layout]].slice(-SAVED_LAYOUTS)));
  } catch {
    // Only the arrangement is lost: the next opening lays the tables out again.
  }
}
