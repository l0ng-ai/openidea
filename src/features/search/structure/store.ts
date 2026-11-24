/**
 * Outline of the active editor, loaded on demand (while the Structure tool
 * window or the File Structure popup is mounted). Reloads when the active
 * editor changes and after 500 ms of idle following edits.
 */
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { editorsFor, useEditorRegistry } from "@/editor/api";
import { onLspRefresh } from "@/editor/lsp/availability";
import { projectPythonHierarchy, pythonSupertypeItems } from "@/editor/navigation/pythonHierarchy";
import { call, commands, IpcError, type OutlineItem, type Pos } from "@/platform/ipc";
import { isVirtualUri } from "@/platform/virtualDocs";
import type { MenuItem } from "@/ui";
import { loadJson, saveJson } from "../common/open";
import { useTracking } from "../common/tracking";
import { inheritedMembers, typeKey, typesIn, type InheritedDeps, type InheritedMember } from "./inherited";
import { allKeys, applyViewFilter, keyOutline, onlyWidgets, sortOutline, withInherited } from "./outline";

interface OutlineState {
  path: string | null;
  doc: number | null;
  items: OutlineItem[] | null;
  /** The Dart server's widget tree of a Flutter file; the Structure view prefers it over `items`. */
  flutter: OutlineItem[] | null;
  loading: boolean;
  error: string | null;
  /** Whether the file's language server answers type hierarchy requests (Show Inherited is offered). */
  inheritedSupported: boolean;
  /** Show Inherited: members of each type's supertypes, by `typeKey`. */
  inherited: ReadonlyMap<string, readonly InheritedMember[]> | null;
}

export const useOutline = create<OutlineState>(() => ({
  path: null,
  doc: null,
  items: null,
  flutter: null,
  loading: false,
  error: null,
  inheritedSupported: false,
  inherited: null,
}));

const IDLE_MS = 500;
let consumers = 0;
let stop: (() => void) | null = null;
let seq = 0;
let flutterSeq = 0;

/** A backend document id for `path` while `fn` runs (open editors are reused). */
async function withDoc<T>(path: string, fn: (doc: number) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc);
  const info = await call(isVirtualUri(path) ? commands.docOpenVirtual(path) : commands.docOpen(path));
  try {
    return await fn(info.id);
  } finally {
    void commands.docClose(info.id);
  }
}

const supertypesOf = (doc: number, pos: Pos) => call(commands.lspTypeHierarchy(doc, pos, "incoming"));

/** Python's supertypes: its servers declare no `typeHierarchyProvider`, the IDE's graph answers instead. */
async function pythonSupertypesOf(path: string, pos: Pos) {
  const hierarchy = await projectPythonHierarchy().catch(() => null);
  return hierarchy ? pythonSupertypeItems(hierarchy, path, pos) : [];
}

export const inheritedDeps = (path: string, doc: number, python = false): InheritedDeps => ({
  supertypes: python
    ? (p, pos) => pythonSupertypesOf(p, pos)
    : (p, pos) => (p === path ? supertypesOf(doc, pos) : withDoc(p, (d) => supertypesOf(d, pos))),
  outline: (p) => (p === path ? call(commands.docOutline(doc)) : withDoc(p, (d) => call(commands.docOutline(d)))),
});

/** Whether a type hierarchy request for the first type reaches a server (none supporting it answers `unavailable`). */
async function probeHierarchy(doc: number, types: readonly OutlineItem[]): Promise<boolean> {
  const first = types[0];
  if (!first) return false;
  try {
    await supertypesOf(doc, first.selection_range.start);
    return true;
  } catch (e) {
    return !(e instanceof IpcError && (e.kind === "unavailable" || e.kind === "cancelled"));
  }
}

async function loadInherited(doc: number, path: string, items: readonly OutlineItem[], my: number, language: string) {
  const types = typesIn(items);
  // Probed once per file; a reload after edits keeps the answer. Python needs no probe: the
  // graph answers its supertypes while its servers declare no type hierarchy.
  const known = useOutline.getState();
  const supported =
    language === "python"
      ? types.length > 0
      : known.path === path && known.inheritedSupported
        ? true
        : await probeHierarchy(doc, types);
  if (my !== seq) return;
  if (!supported || !useStructureOptions.getState().showInherited) {
    useOutline.setState({ inheritedSupported: supported, inherited: null });
    return;
  }
  const deps = inheritedDeps(path, doc, language === "python");
  const entries = await Promise.all(
    types.map(async (t) => [typeKey(t), await inheritedMembers(path, t, deps).catch(() => [])] as const),
  );
  if (my === seq)
    useOutline.setState({ inheritedSupported: true, inherited: new Map(entries.filter(([, m]) => m.length)) });
}

async function loadFlutter(doc: number, language: string) {
  const my = ++flutterSeq;
  const flutter = language === "dart" ? await call(commands.docFlutterOutline(doc)).catch(() => null) : null;
  if (my === flutterSeq) useOutline.setState({ flutter });
}

async function load(doc: number, path: string, language: string) {
  const my = ++seq;
  useOutline.setState((s) =>
    s.path === path
      ? { loading: true }
      : {
          path,
          doc,
          items: null,
          flutter: null,
          loading: true,
          error: null,
          inheritedSupported: false,
          inherited: null,
        },
  );
  void loadFlutter(doc, language);
  try {
    const items = await call(commands.docOutline(doc));
    if (my !== seq) return;
    useOutline.setState({ path, doc, items, loading: false, error: null });
    void loadInherited(doc, path, items, my, language);
  } catch (e) {
    if (my === seq) useOutline.setState({ path, doc, loading: false, error: String((e as Error)?.message ?? e) });
  }
}

function start(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => useEditorRegistry.getState().active?.ctx ?? null;
  const reloadNow = () => {
    clearTimeout(timer);
    const ctx = current();
    if (!ctx) {
      seq++;
      flutterSeq++;
      useOutline.setState({
        path: null,
        doc: null,
        items: null,
        flutter: null,
        loading: false,
        error: null,
        inheritedSupported: false,
        inherited: null,
      });
      return;
    }
    void load(ctx.doc, ctx.path, ctx.language);
  };
  reloadNow();
  const unsubActive = useEditorRegistry.subscribe((s, prev) => {
    if (s.active?.ctx.doc !== prev.active?.ctx.doc || s.active?.ctx.path !== prev.active?.ctx.path) reloadNow();
  });
  const unsubInherited = useStructureOptions.subscribe((s, prev) => {
    if (s.showInherited !== prev.showInherited) reloadNow();
  });
  const unsubEdits = useTracking.subscribe((s, prev) => {
    const ctx = current();
    if (!ctx || s.editVersions.get(ctx.path) === prev.editVersions.get(ctx.path)) return;
    clearTimeout(timer);
    timer = setTimeout(reloadNow, IDLE_MS);
  });
  // Published after each analysis, independently of the requests above.
  const unsubFlutter = onLspRefresh("flutterOutline", () => {
    const ctx = current();
    if (ctx) void loadFlutter(ctx.doc, ctx.language);
  });
  return () => {
    clearTimeout(timer);
    flutterSeq++;
    unsubFlutter();
    unsubActive();
    unsubInherited();
    unsubEdits();
  };
}

/** Keeps the outline live while the calling component is mounted. */
export function useLiveOutline() {
  useEffect(() => {
    if (consumers++ === 0) stop = start();
    return () => {
      if (--consumers === 0) {
        stop?.();
        stop = null;
      }
    };
  }, []);
}

// ---------------------------------------------------------------------------
// View options (persisted)

const OPTIONS_KEY = "openidea.structure.options.v1";

interface StructureOptions {
  alphabetical: boolean;
  /** Select the symbol at the caret (IDEA: off; replaces the old `autoscroll`, which defaulted on). */
  autoscrollFromSource: boolean;
  /** Selecting a symbol shows it in the editor (IDEA: on). */
  autoscrollToSource: boolean;
  /** File Structure popup: typing hides non-matching symbols (else only highlights them). */
  narrowDown: boolean;
  showFields: boolean;
  showNonPublic: boolean;
  sortByVisibility: boolean;
  /** Members inherited from supertypes, greyed (IDEA: off). */
  showInherited: boolean;
  /** Flutter outline: hide declarations without widgets (Flutter plugin: off). */
  showOnlyWidgets: boolean;
}

export const useStructureOptions = create<StructureOptions>(() => ({
  alphabetical: false,
  autoscrollFromSource: false,
  autoscrollToSource: true,
  narrowDown: true,
  showFields: true,
  showNonPublic: true,
  sortByVisibility: false,
  showInherited: false,
  showOnlyWidgets: false,
  ...loadJson<Partial<StructureOptions>>(OPTIONS_KEY, {}),
}));

useStructureOptions.subscribe((s) =>
  saveJson(OPTIONS_KEY, {
    alphabetical: s.alphabetical,
    autoscrollFromSource: s.autoscrollFromSource,
    autoscrollToSource: s.autoscrollToSource,
    narrowDown: s.narrowDown,
    showFields: s.showFields,
    showNonPublic: s.showNonPublic,
    sortByVisibility: s.sortByVisibility,
    showInherited: s.showInherited,
    showOnlyWidgets: s.showOnlyWidgets,
  }),
);

export const useCollapsedStructure = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }));

const outlinePreferences = (s: StructureOptions) => ({
  alphabetical: s.alphabetical,
  sortByVisibility: s.sortByVisibility,
  showFields: s.showFields,
  showNonPublic: s.showNonPublic,
  showInherited: s.showInherited,
  showOnlyWidgets: s.showOnlyWidgets,
});

function outlineNodes(
  items: OutlineState["items"],
  flutter: OutlineState["flutter"],
  inherited: OutlineState["inherited"],
  options: ReturnType<typeof outlinePreferences>,
) {
  const nodes = sortOutline(
    applyViewFilter(withInherited(keyOutline(flutter ?? items ?? []), options.showInherited ? inherited : null), {
      fields: options.showFields,
      nonPublic: options.showNonPublic,
    }),
    options.alphabetical,
    options.sortByVisibility,
  );
  return flutter && options.showOnlyWidgets ? onlyWidgets(nodes) : nodes;
}

export function useOutlineNodes(widgets = false) {
  const items = useOutline((s) => s.items);
  const flutter = useOutline((s) => (widgets ? s.flutter : null));
  const inherited = useOutline((s) => (s.inheritedSupported ? s.inherited : null));
  const options = useStructureOptions(useShallow(outlinePreferences));
  return useMemo(() => outlineNodes(items, flutter, inherited, options), [items, flutter, inherited, options]);
}

function collapseStructure() {
  const { items, flutter, inheritedSupported, inherited } = useOutline.getState();
  const options = {
    ...outlinePreferences(useStructureOptions.getState()),
    alphabetical: false,
    sortByVisibility: false,
  };
  const nodes = outlineNodes(items, flutter, inheritedSupported ? inherited : null, options);
  useCollapsedStructure.setState({ keys: new Set(allKeys(nodes)) });
}

export function useStructureHeaderMenu(): MenuItem[] {
  const ready = useOutline((s) => !!s.path && s.items !== null);
  const fromSource = useStructureOptions((s) => s.autoscrollFromSource);
  const toSource = useStructureOptions((s) => s.autoscrollToSource);
  if (!ready) return [];
  return [
    {
      label: "Expand All",
      icon: "expand-all",
      run: () => useCollapsedStructure.setState({ keys: new Set() }),
    },
    { label: "Collapse All", icon: "collapse-all", run: collapseStructure },
    { kind: "separator" },
    {
      label: "Autoscroll to Source",
      checked: toSource,
      run: () => useStructureOptions.setState({ autoscrollToSource: !toSource }),
    },
    {
      label: "Autoscroll from Source",
      checked: fromSource,
      run: () => useStructureOptions.setState({ autoscrollFromSource: !fromSource }),
    },
  ];
}
