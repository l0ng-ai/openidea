/** Call / type hierarchy state, with lazily expanded levels. */
import { create } from "zustand";
import type { HierarchyDirection, HierarchyItem, OutlineItem, Pos, RequestId, SymbolKind } from "@/bindings";
import {
  classAt,
  classItem,
  isPythonPath,
  projectPythonHierarchy,
  pythonAncestors,
  pythonSubtypes,
} from "@/editor/navigation/pythonHierarchy";
import { incompleteNote } from "@/editor/lsp/lsp";
import { IpcError, call, commands, nextRequestId } from "@/platform/ipc";
import { toolWindowService } from "@/workbench/contributions";
import { basename } from "@/platform/project";
import {
  caretContext,
  caretSynced,
  hint,
  isUnavailable,
  lspRequest,
  reportError,
  withDocument,
  type CaretContext,
} from "./ipc";
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
  /** The server's detail for the root type (its package for Java), shown beside the name. */
  detail?: string | null;
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
  /** Ids of the expanded nodes, so a tab shown again keeps its tree open. */
  expanded: readonly string[];
  /** Bumped per (re)query so stale responses are dropped and the tree resets. */
  generation: number;
  /** Content tabs; the selected one's hierarchy is the state above. */
  tabs: readonly HierarchyTab[];
  active: number | null;
}

/** The hierarchy of a tab that isn't selected. */
export type SavedHierarchy = Pick<
  HierarchyState,
  "mode" | "direction" | "root" | "children" | "failed" | "notes" | "loading" | "expanded"
>;

export interface HierarchyTab {
  id: number;
  /** Pinned: a new hierarchy opens beside it instead of taking its place. */
  pinned: boolean;
  /** Null for the selected tab. */
  saved: SavedHierarchy | null;
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
  expanded: [ROOT_ID],
  generation: 0,
  tabs: [],
  active: null,
}));

let tabSeq = 0;

function saved(s: HierarchyState): SavedHierarchy {
  const { mode, direction, root, children, failed, notes, loading, expanded } = s;
  return { mode, direction, root, children, failed, notes, loading, expanded };
}

/** A tab's mode, direction and root: the live state's for the selected one. */
export function tabHierarchy(s: HierarchyState, tab: HierarchyTab): SavedHierarchy {
  return tab.saved ?? saved(s);
}

/**
 * As IDEA: a new hierarchy takes the place of the selected tab unless it is pinned,
 * then it opens in a tab of its own.
 */
function openTab() {
  const s = useHierarchy.getState();
  const current = s.tabs.find((t) => t.id === s.active);
  if (current && !current.pinned) return;
  cancelInflight();
  const id = ++tabSeq;
  useHierarchy.setState({
    tabs: [
      ...s.tabs.map((t) => (t.id === s.active ? { ...t, saved: saved(s) } : t)),
      { id, pinned: false, saved: null },
    ],
    active: id,
    root: null,
    children: new Map(),
    failed: new Set(),
    notes: new Map(),
    loading: false,
    expanded: [ROOT_ID],
    generation: s.generation + 1,
  });
}

export function selectHierarchyTab(id: number) {
  const s = useHierarchy.getState();
  const target = s.tabs.find((t) => t.id === id);
  if (id === s.active || !target?.saved) return;
  cancelInflight();
  const next = target.saved;
  useHierarchy.setState({
    ...next,
    loading: false,
    generation: s.generation + 1,
    active: id,
    tabs: s.tabs.map((t) => (t.id === s.active ? { ...t, saved: saved(s) } : t.id === id ? { ...t, saved: null } : t)),
  });
  // Its requests were dropped when it was left: load it again.
  if (next.loading) void loadRoot();
}

/** Closes a tab; the tool window goes with the last one. */
export function closeHierarchyTab(id: number) {
  const s = useHierarchy.getState();
  const at = s.tabs.findIndex((t) => t.id === id);
  if (at < 0) return;
  const rest = s.tabs.filter((t) => t.id !== id);
  if (!rest.length) {
    closeHierarchy();
    return;
  }
  if (id !== s.active) {
    useHierarchy.setState({ tabs: rest });
    return;
  }
  useHierarchy.setState({ tabs: rest, active: null });
  selectHierarchyTab((s.tabs[at + 1] ?? s.tabs[at - 1])!.id);
}

export function pinHierarchyTab(id: number, pinned: boolean) {
  useHierarchy.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)) }));
}

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
    expanded: [ROOT_ID],
    generation: s.generation + 1,
    tabs: [],
    active: null,
  }));
}

/** Closes the hierarchy's content tab; with no content left the tool window and its stripe button go. */
export function closeHierarchy() {
  resetHierarchy();
  toolWindowService().hide("hierarchy", { removeFromStripe: true });
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

/** `first`, then the items of `more` no item of `first` already names. */
function mergeItems(first: readonly HierarchyItem[], more: readonly HierarchyItem[]): HierarchyItem[] {
  const seen = new Set(first.map(itemKey));
  return [...first, ...more.filter((item) => !seen.has(itemKey(item)))];
}

/**
 * Type hierarchy items of the type at `pos`. A Python server's answer is merged with the
 * IDE's inheritance graph rather than trusted: pyrefly answers only what it resolved in
 * its own root (`object` for a class whose base lives in an attached project), so a
 * non-empty answer still misses the attached project's supertypes.
 */
async function typeHierarchyItems(
  path: string,
  doc: number,
  pos: Pos,
  direction: HierarchyDirection,
): Promise<HierarchyItem[]> {
  const python = isPythonPath(path);
  let served: HierarchyItem[] = [];
  let unavailable = false;
  try {
    served = await lspRequest(() => commands.lspTypeHierarchy(doc, pos, direction));
  } catch (e) {
    if (!python || !isUnavailable(e)) throw e;
    unavailable = true;
  }
  if (!python) return served;
  const hierarchy = await projectPythonHierarchy();
  const cls = classAt(hierarchy, path, pos);
  if (!cls) {
    if (unavailable) throw new IpcError({ kind: "notFound", message: "No type at the caret" });
    return served;
  }
  // Supertypes are the whole chain, subtypes only the direct ones: each node expands lazily.
  const graph = direction === "incoming" ? await pythonAncestors(hierarchy, cls) : await pythonSubtypes(hierarchy, cls);
  return mergeItems(served, graph.map(classItem));
}

async function request(
  mode: HierarchyMode,
  doc: number,
  path: string,
  line: number,
  col: number,
  direction: HierarchyDirection,
) {
  if (mode === "type")
    return { items: await typeHierarchyItems(path, doc, { line, col }, direction), incomplete: null };
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

/** The root type's detail (Java: its package), like the nodes below it show theirs. */
async function loadRootDetail(generation: number, root: HierarchyRoot) {
  try {
    const item = await withDocument(root.path, (doc) =>
      call(commands.lspPrepareTypeHierarchy(doc, { line: root.line, col: root.col })),
    );
    const s = useHierarchy.getState();
    if (s.generation !== generation || s.root !== root || !item?.detail) return;
    useHierarchy.setState({ root: { ...root, detail: item.detail } });
  } catch {
    // Older servers (remote) and servers without type hierarchy: the name alone.
  }
}

/** Loads the root's level. `quiet`: a position without a symbol isn't reported (the caller retries). */
async function loadRoot(quiet = false): Promise<RootResult> {
  const s = useHierarchy.getState();
  const root = s.root;
  if (!root) return "stale";
  const generation = s.generation + 1;
  cancelInflight();
  useHierarchy.setState({
    generation,
    children: new Map(),
    failed: new Set(),
    notes: new Map(),
    loading: true,
    expanded: [ROOT_ID],
  });
  try {
    const { items, incomplete } = await withDocument(root.path, (doc) =>
      request(s.mode, doc, root.path, root.line, root.col, s.direction),
    );
    setChildren(generation, ROOT_ID, [rootKey(root)], items, incomplete && incompleteNote(incomplete, root.name));
    prefetchLevels(useHierarchy.getState().children.get(ROOT_ID) ?? []);
    if (s.mode === "type") void loadRootDetail(generation, root);
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
      request(mode, doc, node.item.path, at.line, at.col, direction),
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
  openTab();
  const s = useHierarchy.getState();
  const direction = s.mode === mode ? s.direction : mode === "call" ? "incoming" : "outgoing";
  useHierarchy.setState({
    mode,
    direction,
    root: { name: c.word ?? basename(c.path), path: c.path, line: c.line, col: c.col },
  });
  toolWindowService().show("hierarchy");
  await caretSynced(c);
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
