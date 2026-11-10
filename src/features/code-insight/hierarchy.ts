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
  /** Set when the node repeats an ancestor: it is kept a leaf and marked "recursive". */
  recursion?: boolean;
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

/** Closes the hierarchy's content tab; with no content left the tool window hides. */
export function closeHierarchy() {
  resetHierarchy();
  toolWindowService().hide("hierarchy");
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

/** Position-unique key of a hierarchy item: the same symbol always has the same one. */
function itemKey(item: HierarchyItem): string {
  const p = item.selectionRange.start;
  return `${item.path}:${p.line}:${p.col}:${item.name}`;
}

/** The root's key, matching itemKey of the item its position resolves to. */
function rootKey(root: HierarchyRoot): string {
  return `${root.path}:${root.line}:${root.col}:${root.name}`;
}

/** Each node's position key plus its ancestors', so a child repeating one is a cycle. */
const nodeKeys = new WeakMap<HierarchyNode, readonly string[]>();

function setChildren(
  generation: number,
  parent: string,
  parentKeys: readonly string[],
  items: HierarchyItem[],
  note: string | null,
) {
  const s = useHierarchy.getState();
  if (s.generation !== generation) return;
  const ancestors = new Set(parentKeys);
  const seen = new Set<string>();
  const nodes: HierarchyNode[] = [];
  const children = new Map(s.children);
  children.set(parent, nodes);
  for (const item of items) {
    const id = childId(parent, item);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = itemKey(item);
    // A recursive symbol arrives with a fresh id on every level (the id carries the
    // parent chain); only its position key reveals the cycle. Keep such a node a
    // leaf — expanding it again would request the same level forever.
    const node: HierarchyNode = ancestors.has(key) ? { id, item, recursion: true } : { id, item };
    if (node.recursion) children.set(id, []);
    nodeKeys.set(node, [...parentKeys, key]);
    nodes.push(node);
  }
  useHierarchy.setState({
    children,
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
    setChildren(generation, ROOT_ID, [rootKey(root)], items, incomplete && incompleteNote(incomplete, root.name));
    prefetchLevels(useHierarchy.getState().children.get(ROOT_ID) ?? []);
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
/** Loads `node`'s level. `ahead`: a look-ahead load (prefetchLevels), which reports nothing. */
export async function loadChildren(node: HierarchyNode, ahead = false) {
  const { mode, direction, generation } = useHierarchy.getState();
  const at = node.item.selectionRange.start;
  try {
    const { items, incomplete } = await withDocument(node.item.path, (doc) =>
      request(mode, doc, at.line, at.col, direction),
    );
    setChildren(
      generation,
      node.id,
      nodeKeys.get(node) ?? [],
      items,
      incomplete && incompleteNote(incomplete, node.item.name),
    );
    if (!ahead) prefetchLevels(useHierarchy.getState().children.get(node.id) ?? []);
  } catch (e) {
    if (ahead || useHierarchy.getState().generation !== generation) return;
    useHierarchy.setState((st) => ({
      failed: new Set(st.failed).add(node.id),
      children: new Map(st.children).set(node.id, []),
    }));
    reportError(e);
  }
}

const AHEAD_CONCURRENCY = 4;
const ahead: HierarchyNode[] = [];
let aheadRunning = 0;
let aheadGeneration = -1;

/**
 * IDEA's type hierarchy shows no expand arrow on a type without subtypes (or supertypes): the
 * level below each shown node is loaded ahead, a few requests at a time. Call hierarchies stay
 * lazy, as in IDEA.
 */
export function prefetchLevels(nodes: readonly HierarchyNode[]) {
  const { mode, generation, children } = useHierarchy.getState();
  if (mode !== "type") return;
  if (aheadGeneration !== generation) {
    ahead.length = 0;
    aheadGeneration = generation;
  }
  for (const n of nodes) if (!n.recursion && !children.has(n.id) && !ahead.includes(n)) ahead.push(n);
  pumpAhead();
}

function pumpAhead() {
  while (aheadRunning < AHEAD_CONCURRENCY && ahead.length) {
    const node = ahead.shift()!;
    const { generation, children } = useHierarchy.getState();
    if (generation !== aheadGeneration || children.has(node.id)) continue;
    aheadRunning++;
    void loadChildren(node, true).finally(() => {
      aheadRunning--;
      pumpAhead();
    });
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
