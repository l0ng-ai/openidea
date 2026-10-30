/** Call / type hierarchy state, with lazily expanded levels. */
import { create } from "zustand";
import type { HierarchyDirection, HierarchyItem, OutlineItem, Pos, RequestId, SymbolKind } from "@/bindings";
import { incompleteNote } from "@/editor/lsp/lsp";
import { IpcError, call, commands, nextRequestId } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import { basename } from "@/platform/project";
import { caretContext, hint, lspRequest, reportError, withDocument, type CaretContext } from "./ipc";
import { tx } from "@/platform/i18n";

export type HierarchyMode = "call" | "type";

export interface HierarchyNode {
  id: string;
  item: HierarchyItem;
}

export interface HierarchyRoot {
  name: string;
  path: string;
  line: number;
  col: number;
}

interface HierarchyState {
  mode: HierarchyMode;
  direction: HierarchyDirection;
  root: HierarchyRoot | null;
  /** Parent id ("root" for the top level) → loaded children. */
  children: ReadonlyMap<string, HierarchyNode[]>;
  /** Parent ids whose children failed to load. */
  failed: ReadonlySet<string>;
  /** Parent id → why its children may be missing callers. */
  notes: ReadonlyMap<string, string>;
  loading: boolean;
  /** Bumped per (re)query so stale responses are dropped and the tree resets. */
  generation: number;
}

export const ROOT_ID = "root";

export const useHierarchy = create<HierarchyState>(() => ({
  mode: "call",
  direction: "incoming",
  root: null,
  children: new Map(),
  failed: new Set(),
  notes: new Map(),
  loading: false,
  generation: 0,
}));

/** Call hierarchy requests the current tree still waits for. */
const inflight = new Set<RequestId>();

function cancelInflight() {
  for (const request of inflight) void commands.cancelRequest(request).catch(() => {});
  inflight.clear();
}

/** The window switched projects: the tree refers to the previous one's documents. */
export function resetHierarchy() {
  cancelInflight();
  useHierarchy.setState((s) => ({
    root: null,
    children: new Map(),
    failed: new Set(),
    notes: new Map(),
    loading: false,
    generation: s.generation + 1,
  }));
}

/** The empty-result line of the hierarchy tree. */
export function noneFoundLabel(mode: HierarchyMode, direction: HierarchyDirection): string {
  if (mode === "call") return direction === "incoming" ? tx`— no callers found` : tx`— no callees found`;
  return direction === "incoming" ? tx`— no supertypes found` : tx`— no subtypes found`;
}

export function directionLabel(mode: HierarchyMode, direction: HierarchyDirection): string {
  if (mode === "call") return direction === "incoming" ? tx("Callers") : tx("Callees");
  return direction === "incoming" ? tx("Supertypes") : tx("Subtypes");
}

/** The tab title of the hierarchy tree, e.g. "Callers of main". */
export function hierarchyTitle(mode: HierarchyMode, direction: HierarchyDirection, name: string): string {
  if (mode === "call") return direction === "incoming" ? tx`Callers of ${name}` : tx`Callees of ${name}`;
  return direction === "incoming" ? tx`Supertypes of ${name}` : tx`Subtypes of ${name}`;
}

async function request(mode: HierarchyMode, doc: number, line: number, col: number, direction: HierarchyDirection) {
  if (mode === "type") {
    const items = await lspRequest(() => commands.lspTypeHierarchy(doc, { line, col }, direction));
    return { items, incomplete: null };
  }
  const id = nextRequestId();
  inflight.add(id);
  try {
    return await lspRequest(() => commands.lspCallHierarchy(id, doc, { line, col }, direction));
  } finally {
    inflight.delete(id);
  }
}

export function childId(parent: string, item: HierarchyItem): string {
  const p = item.selectionRange.start;
  return `${parent}/${item.path}:${p.line}:${p.col}:${item.name}`;
}

function setChildren(generation: number, parent: string, items: HierarchyItem[], note: string | null) {
  const s = useHierarchy.getState();
  if (s.generation !== generation) return;
  const seen = new Set<string>();
  const nodes: HierarchyNode[] = [];
  for (const item of items) {
    const id = childId(parent, item);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, item });
  }
  useHierarchy.setState({
    children: new Map(s.children).set(parent, nodes),
    ...(note ? { notes: new Map(s.notes).set(parent, note) } : {}),
  });
}

type RootResult = "loaded" | "noTarget" | "failed" | "stale";

/** Loads the root's level. `quiet`: a position without a symbol isn't reported (the caller retries). */
async function loadRoot(quiet = false): Promise<RootResult> {
  const s = useHierarchy.getState();
  const root = s.root;
  if (!root) return "stale";
  const generation = s.generation + 1;
  cancelInflight();
  useHierarchy.setState({ generation, children: new Map(), failed: new Set(), notes: new Map(), loading: true });
  try {
    const { items, incomplete } = await withDocument(root.path, (doc) =>
      request(s.mode, doc, root.line, root.col, s.direction),
    );
    setChildren(generation, ROOT_ID, items, incomplete && incompleteNote(incomplete, root.name));
    return "loaded";
  } catch (e) {
    if (useHierarchy.getState().generation !== generation) return "stale";
    const noTarget = e instanceof IpcError && e.kind === "notFound";
    if (quiet && noTarget) return "noTarget";
    useHierarchy.setState((st) => ({ failed: new Set(st.failed).add(ROOT_ID) }));
    reportError(e);
    return noTarget ? "noTarget" : "failed";
  } finally {
    if (useHierarchy.getState().generation === generation) useHierarchy.setState({ loading: false });
  }
}

const CALLABLE = new Set<SymbolKind>(["function", "method", "constructor"]);
const TYPES = new Set<SymbolKind>(["class", "interface", "struct", "enum", "trait"]);

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.col <= b.col);

/** The innermost outline symbol of `kinds` whose extent contains `pos`. */
export function enclosingDeclaration(
  items: readonly OutlineItem[],
  pos: Pos,
  kinds: ReadonlySet<SymbolKind>,
): OutlineItem | null {
  for (const item of items) {
    if (!before(item.range.start, pos) || !before(pos, item.range.end)) continue;
    return enclosingDeclaration(item.children, pos, kinds) ?? (kinds.has(item.kind) ? item : null);
  }
  return null;
}

/** IDEA: inside a method / class body the hierarchy is the enclosing declaration's. */
async function enclosingRoot(c: CaretContext, mode: HierarchyMode): Promise<HierarchyRoot | null> {
  try {
    const outline = await call(commands.docOutline(c.doc));
    const decl = enclosingDeclaration(outline, { line: c.line, col: c.col }, mode === "call" ? CALLABLE : TYPES);
    if (!decl) return null;
    const at = decl.selection_range.start;
    return { name: decl.name, path: c.path, line: at.line, col: at.col };
  } catch {
    return null;
  }
}
export async function loadChildren(node: HierarchyNode) {
  const { mode, direction, generation } = useHierarchy.getState();
  const at = node.item.selectionRange.start;
  try {
    const { items, incomplete } = await withDocument(node.item.path, (doc) =>
      request(mode, doc, at.line, at.col, direction),
    );
    setChildren(generation, node.id, items, incomplete && incompleteNote(incomplete, node.item.name));
  } catch (e) {
    if (useHierarchy.getState().generation !== generation) return;
    useHierarchy.setState((st) => ({
      failed: new Set(st.failed).add(node.id),
      children: new Map(st.children).set(node.id, []),
    }));
    reportError(e);
  }
}

export async function showHierarchy(mode: HierarchyMode) {
  const c = caretContext();
  if (!c) {
    hint("Open a file to show the hierarchy");
    return;
  }
  const s = useHierarchy.getState();
  const direction = s.mode === mode ? s.direction : mode === "call" ? "incoming" : "outgoing";
  useHierarchy.setState({
    mode,
    direction,
    root: { name: c.word ?? basename(c.path), path: c.path, line: c.line, col: c.col },
  });
  toolWindowService().show("hierarchy");
  if ((await loadRoot(true)) !== "noTarget") return;
  // Nothing at the caret: retry at the enclosing method / class.
  const root = await enclosingRoot(c, mode);
  const now = useHierarchy.getState();
  if (now.mode !== mode || now.root?.path !== c.path || now.root.line !== c.line || now.root.col !== c.col) return;
  if (root && (root.line !== c.line || root.col !== c.col)) {
    useHierarchy.setState({ root });
    await loadRoot();
  } else {
    useHierarchy.setState((st) => ({ failed: new Set(st.failed).add(ROOT_ID) }));
    hint(
      mode === "call"
        ? "No method at the caret to show the call hierarchy of"
        : "No type at the caret to show the hierarchy of",
    );
  }
}

/** Where activating a node goes: a caller's call site (as IDEA), else the symbol itself. */
export function hierarchyTarget(
  mode: HierarchyMode,
  direction: HierarchyDirection,
  item: HierarchyItem,
): { path: string; line: number; col: number } {
  const at =
    mode === "call" && direction === "incoming" && item.fromRanges[0]
      ? item.fromRanges[0].start
      : item.selectionRange.start;
  return { path: item.path, line: at.line, col: at.col };
}

export function setDirection(direction: HierarchyDirection) {
  if (useHierarchy.getState().direction === direction) return;
  useHierarchy.setState({ direction });
  void loadRoot();
}

export function refreshHierarchy() {
  void loadRoot();
}
