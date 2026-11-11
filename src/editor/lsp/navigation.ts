import {
  contributedNavigation,
  navigationEpoch,
  onNavigationProvidersChanged,
  type NavigationMatch,
} from "../navigationProviders";
/**
 * Go to declaration / implementation / type declaration (⌘B, ⌥⌘B, ⇧⌘B,
 * ⌘-click with a link underline while ⌘ is held, and a plain middle-button
 * click), the multiple-targets chooser, and document highlights (occurrences
 * of the symbol at the caret, plus the sticky find.highlightUsages variant).
 */
import { EditorSelection, Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { Channel } from "@tauri-apps/api/core";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type DocId,
  type GotoKind,
  type Highlight,
  type Location,
  type Pos,
  type RequestId,
  type WebReferenceKind,
} from "@/platform/ipc";
import {
  CONTRIBUTED_DEFINITION,
  activeEditor,
  contributedAt,
  whenSynced,
  type ContributedDefinition,
  type EditorDocContext,
} from "@/editor/api";
import { structure } from "@/editor/structure";
import { executeAction } from "@/platform/actions";
import { basename, relativePath, useProject } from "@/platform/project";
import { editorService } from "@/workbench/contributions";
import { fileIconName } from "@/ui";
import { NO_SERVER, debounce, docOf, isUnavailable, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, rangeContains, rangeToOffsets } from "./positions";
import {
  SYNTAX_NOTE,
  declarationFallback,
  indexDefinitions,
  isSelfTarget,
  localHighlights,
  type DeclarationTarget,
} from "./syntaxFallback";
import { showHint, showPendingHint } from "./hint";
import { outsideProjectReason } from "./outsideProject";
import { caretAnchor, openPopup, updatePopup, type ListPopupItem } from "./popupStore";
import { readManyFileLines, targetLabel } from "./files";
import {
  documentLinks,
  followReference,
  fragmentOffset,
  knownLinks,
  linkReference,
  referenceAt,
  textReference,
} from "./links";
import { featureBackoff } from "./availability";
import { requestHover, showPhpConstructDocumentation } from "./hover";
import { declarationSummary, renderCode } from "./markdown";
import { enclosingType } from "@/editor/navigation/lineMarkers";
import { editorPrefs } from "@/platform/editorSettings";
import { isVirtualUri, virtualContainer } from "@/platform/virtualDocs";
import { isAddCaretGesture } from "@/editor/core/cm/multiCaret";
import { dispatchMouseShortcut, shortcutLabel } from "@/platform/keymap";
import { isNavigationGesture, onNavigationModifier, navigationModifierHeld } from "@/platform/navigationModifier";
import { create } from "zustand";
import { tx } from "@/platform/i18n";
import {
  CONFIGURATION_NAVIGATION_MAX_AGE,
  configurationNavigationRevision,
  navigationWord,
  hasConfigurationNavigation,
  invalidateConfigurationNavigation,
  isConfigurationDocument,
  requestNavigation,
} from "./configurationNavigation";

const highlightsBackoff = featureBackoff();

export async function navigateTo(loc: Location) {
  await editorService().openFile(loc.path, {
    selection: { line: loc.range.start.line, col: loc.range.start.col },
    focus: true,
  });
}

const NOT_FOUND: Record<GotoKind, string> = {
  definition: "Cannot find declaration to go to",
  declaration: "Cannot find declaration to go to",
  implementation: "No implementations found",
  typeDefinition: "Cannot find type declaration",
};

const TITLES: Record<GotoKind, string> = {
  definition: "Choose Declaration",
  declaration: "Choose Declaration",
  implementation: "Choose Implementation",
  typeDefinition: "Choose Type Declaration",
};

export function dedupeLocations<T extends Location>(locs: readonly T[]): T[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${l.path}:${l.range.start.line}:${l.range.start.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Last segments of an absolute path, `…`-prefixed (IDEA's Go to File style). */
function tailPath(path: string, keep = 2): string {
  const parts = path.split("/");
  return parts.length <= keep ? path : `…/${parts.slice(-keep).join("/")}`;
}

/** The `path:line` after a chooser row's name: project-relative, or a `…`-tail outside the project. */
function chooserWhere(root: string, path: string, line: number): string {
  if (isVirtualUri(path)) return `${virtualContainer(path)}:${line}`;
  const p = relativePath(root, path);
  return `${p === path ? tailPath(p) : p}:${line}`;
}

/**
 * The index's container for each server target (exact path+range match), keyed by
 * target index; misses (fresh edits, excluded folders, outside the project) fall
 * back to the enclosing-type heuristic. One query per distinct target name; index
 * symbols carry their container already and are not queried.
 */
async function indexContainers(
  locs: readonly DeclarationTarget[],
  names: readonly (string | null)[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byName = new Map<string, number[]>();
  locs.forEach((l, i) => {
    if (l.kind && l.name) return;
    const name = names[i];
    if (name) byName.set(name, (byName.get(name) ?? []).concat(i));
  });
  await Promise.all(
    [...byName].map(async ([name, at]) => {
      try {
        const matches = await call(commands.findSymbols(name, "all", SYMBOL_LIMIT));
        for (const i of at) {
          const l = locs[i]!;
          const hit = matches.find(
            (m) =>
              m.path === l.path && m.range.start.line === l.range.start.line && m.range.start.col === l.range.start.col,
          );
          if (hit?.container) out.set(i, hit.container);
        }
      } catch {
        // The index is optional here; the heuristic answers instead.
      }
    }),
  );
  return out;
}

const SYMBOL_LIMIT = 500;

/** Popup items for locations: icon + name, the container, and `path:line` (IDEA's chooser rows). */
export async function locationItems(locs: readonly DeclarationTarget[]): Promise<ListPopupItem[]> {
  const files = await readManyFileLines(locs.map((l) => l.path));
  const root = useProject.getState().project?.root ?? "";
  const names = locs.map((l) => targetLabel(files.get(l.path)?.[l.range.start.line] ?? "", l.range.start.col));
  const indexed = await indexContainers(locs, names);
  return locs.map((l, i) => {
    const where = chooserWhere(root, l.path, l.range.start.line + 1);
    // Index symbols carry their container; server targets take the index's answer or the enclosing type.
    if (l.kind && l.name)
      return {
        id: `${i}`,
        label: l.name,
        detail: [l.container, where].filter(Boolean).join(" · "),
        symbol: l.kind,
        run: () => navigateTo(l),
      };
    return {
      id: `${i}`,
      label: names[i] ?? basename(l.path),
      detail: [indexed.get(i) ?? enclosingType(files.get(l.path), l), where].filter(Boolean).join(" · "),
      icon: fileIconName(basename(l.path), l.path),
      run: () => navigateTo(l),
    };
  });
}

/** "Choose Implementation of foo (3 found)". */
export function chooserTitle(kind: GotoKind, name: string | null, count: number, fromSyntax = false): string {
  if (kind === "implementation" && !fromSyntax)
    return name ? tx`Choose Implementation of ${name} (${count} found)` : tx`Choose Implementation (${count} found)`;
  return `${TITLES[kind]}${name ? ` of ${name}` : ""} (${count} found${fromSyntax ? ", based on syntax" : ""})`;
}

/** The chooser's title while the server is still searching for more. */
function searchingTitle(name: string | null, count: number): string {
  return name
    ? tx`Choose Implementation of ${name} (${count} found, searching…)`
    : tx`Choose Implementation (${count} found, searching…)`;
}

function nameAt(view: EditorView, offset: number): string | null {
  const word = navigationWord(view, offset);
  return word ? view.state.sliceDoc(word.from, word.to) : null;
}

/**
 * Go to Implementation whose chooser opens with the implementations the server finds first
 * (Java: the project's) while it searches on (the dependencies'), and fills in when it ends.
 * Closing the chooser cancels the search.
 */
function streamedImplementations(view: EditorView, offset: number, onOpen: () => void, superseded: () => boolean) {
  const name = nameAt(view, offset);
  let current: RequestId | null = null;
  let finished = false;
  let opened = false;
  let closed = false;
  let first: DeclarationTarget[] = [];
  let showing: Promise<void> = Promise.resolve();
  return {
    request(doc: DocId, pos: Pos): Promise<DeclarationTarget[]> {
      const request = (current = nextRequestId());
      finished = false;
      const channel = new Channel<Location[]>();
      channel.onmessage = (locs) => {
        if (finished || opened || current !== request || !locs.length || superseded()) return;
        opened = true;
        onOpen();
        first = dedupeLocations(locs);
        showing = locationItems(first).then((items) => {
          // All of them arrived meanwhile: shown as usual.
          if (finished || superseded()) {
            opened = false;
            return;
          }
          openPopup({
            kind: "list",
            anchor: caretAnchor(view, offset),
            title: searchingTitle(name, first.length),
            items,
            pin: pinToFind(name ?? "", first),
            onClose: () => {
              closed = true;
              if (!finished) void commands.cancelRequest(request).catch(() => {});
            },
          });
        });
      };
      return lspRequest(() => commands.lspGotoImplementation(request, doc, pos, channel)).finally(() => {
        finished = true;
      });
    },
    /** Whether the chooser opened with the first ones (and so the search's result goes there). */
    async opened(): Promise<boolean> {
      await showing;
      return opened;
    },
    /** Fills the opened chooser with all of them, after those it shows. */
    async complete(locs: readonly DeclarationTarget[]) {
      if (closed || superseded()) return;
      const all = dedupeLocations([...first, ...locs]);
      const items = await locationItems(all);
      if (closed || superseded()) return;
      updatePopup("list", {
        title: chooserTitle("implementation", name, all.length),
        items,
        pin: pinToFind(name ?? "", all),
      });
    },
  };
}

/** Pin button of the targets chooser: the targets as a Find tool window tab (code-insight). */
export function pinToFind(symbol: string, locations: readonly Location[]) {
  return {
    label: "Open in Find Tool Window",
    run: () => void executeAction("find.showUsageResults", { symbol, locations }),
  };
}

/** When each editor's document last changed (`performance.now()`). */
const editedAt = new WeakMap<EditorView, number>();

/**
 * Some servers analyse an edit asynchronously and answer from the previous
 * version meanwhile (kotlin-language-server: nothing for ~300 ms after typing).
 * An empty answer right after an edit is asked again a few times.
 */
async function gotoAfterEdits(
  view: EditorView,
  request: () => Promise<DeclarationTarget[]>,
  superseded: () => boolean,
) {
  for (let attempt = 0; ; attempt++) {
    const locs = await request();
    if (locs.length || attempt >= 3 || superseded() || performance.now() - (editedAt.get(view) ?? -Infinity) > 1500)
      return locs;
    await new Promise((r) => setTimeout(r, 250));
    if (superseded()) return [];
  }
}

/** The latest go-to gesture per editor; an older one answered later must not navigate or show anything. */
const latestGesture = new WeakMap<EditorView, number>();
const pendingGestureHints = new WeakMap<EditorView, () => void>();
let gestures = 0;

export async function gotoTargets(view: EditorView, kind: GotoKind, at?: number) {
  const gesture = ++gestures;
  latestGesture.set(view, gesture);
  pendingGestureHints.get(view)?.();
  pendingGestureHints.delete(view);
  const source = view.state.doc;
  const context = docOf(view);
  const superseded = () =>
    latestGesture.get(view) !== gesture ||
    !view.dom.isConnected ||
    view.state.doc !== source ||
    docOf(view) !== context;
  const offset = at ?? view.state.selection.main.head;
  if (kind === "definition" || kind === "declaration") {
    const own = contributedAt<ContributedDefinition>(view.state, CONTRIBUTED_DEFINITION, offset);
    if (own?.(view, offset)) return;
    if (showPhpConstructDocumentation(view, offset)) return;
    const before = view.state.doc;
    const plugin = await contributedNavigation(view, offset).catch(() => null);
    if (view.state.doc !== before || superseded()) return;
    if (plugin) {
      if (plugin.targets.length === 1) await navigateTo(plugin.targets[0]!);
      else {
        const items = await locationItems(plugin.targets);
        if (superseded()) return;
        openPopup({
          kind: "list",
          anchor: caretAnchor(view, offset),
          title: tx`Choose Declaration`,
          items,
          pin: pinToFind(view.state.sliceDoc(plugin.from, plugin.to), plugin.targets),
        });
      }
      return;
    }
  }
  const doc = docOf(view);
  if (!doc) return;
  const pos = offsetToPos(view.state.doc, offset);
  let locs: DeclarationTarget[];
  let fromSyntax = false;
  const declaration = kind === "definition" || kind === "declaration";
  // A segment of an import path names a file — possibly in a dependency project, which
  // neither the single-root server nor the name index resolves.
  const moduleName = declaration ? importModuleName(view, doc, offset) : null;
  if (moduleName) {
    const module = await moduleFile(doc, moduleName).catch(() => null);
    if (module) {
      await navigateTo(module);
      return;
    }
  }
  let serverDown = false;
  let streamed: ReturnType<typeof streamedImplementations> | null = null;
  try {
    const done = showPendingHint(view, tx`Finding navigation target…`);
    pendingGestureHints.set(view, done);
    const stream = kind === "implementation" ? streamedImplementations(view, offset, done, superseded) : null;
    streamed = stream;
    const request = stream ? () => stream.request(doc.doc, pos) : () => requestNavigation(view, offset, kind);
    try {
      locs = dedupeLocations(await gotoAfterEdits(view, request, superseded));
    } finally {
      done();
      if (pendingGestureHints.get(view) === done) pendingGestureHints.delete(view);
    }
  } catch (e) {
    // The chooser shows the first ones: closing it cancelled the search, or the rest failed.
    if (streamed && (await streamed.opened())) {
      await streamed.complete([]);
      return;
    }
    if (superseded()) return;
    if (isCancelled(e) || !declaration) {
      reportLspError(view, e, true);
      return;
    }
    // Web references and links need no server.
    if (
      (await gotoWebReference(view, doc, pos, offset, superseded)) ||
      (await followReferenceAt(view, doc, offset, superseded))
    )
      return;
    serverDown = isUnavailable(e);
    // Dumb mode: the server is not ready / failing — answer from the syntax tree.
    // An import path is not a name to look up: only its file matters.
    const fb = moduleName ? null : await gotoFallback(view, doc, pos);
    if (superseded()) return;
    if (!fb) {
      reportLspError(view, e, true);
      return;
    }
    locs = fb;
    fromSyntax = true;
  }
  if (streamed && (await streamed.opened())) {
    await streamed.complete(locs);
    return;
  }
  if (superseded()) return;
  if (!locs.length) {
    // The server has no definition here: a link (`href`, `#include`, Markdown) or a file path.
    if (
      declaration &&
      !fromSyntax &&
      ((await gotoWebReference(view, doc, pos, offset, superseded)) ||
        (await followReferenceAt(view, doc, offset, superseded)))
    )
      return;
    if (superseded()) return;
    // The server only resolves what it sees: answer from the project index, which also
    // covers attached dependency projects (an unresolved import into them). Never for a
    // module path: a segment is not a symbol name.
    if (declaration && !fromSyntax && !moduleName) {
      const name = nameAt(view, offset);
      const targets = name ? await indexDefinitions(doc.path, name).catch(() => []) : [];
      if (targets.length) {
        if (isSelfTarget(targets, doc.path, pos)) {
          if (!(await executeAction("find.showUsages"))) showHint(view, "No usages found");
          return;
        }
        if (targets.length === 1) {
          await navigateTo(targets[0]!);
          return;
        }
        openPopup({
          kind: "list",
          anchor: caretAnchor(view, offset),
          title: chooserTitle(kind, name, targets.length),
          items: await locationItems(targets),
          pin: pinToFind(name ?? "", targets),
        });
        return;
      }
    }
    // The server only checks this file's syntax: say why instead of just "not found".
    const reason = serverDown ? null : outsideProjectReason(doc.path);
    showHint(
      view,
      serverDown
        ? `${NOT_FOUND[kind]}: no language server is running for this file`
        : reason
          ? `${tx(NOT_FOUND[kind])}. ${tx(reason)}`
          : NOT_FOUND[kind],
    );
    return;
  }
  // IDEA: ⌘B on a declaration shows its usages — also when a plugin adds targets of its own,
  // such as a MyBatis mapper method's XML statement (#1745), which its gutter icon still reaches.
  if (kind === "definition" && locs.some((l) => isSelfTarget([l], doc.path, pos))) {
    // An imported name is not the declaration it means: when the server points at the import
    // itself (it analyses one root and cannot see the dependency project), the import names
    // the module the declaration lives in. Prefer that module — the bare name alone matches
    // unrelated declarations of the same name in other roots.
    const modulePath = importedModulePath(view, offset);
    const name = modulePath ? importedDeclarationName(view, offset) : null;
    let others: DeclarationTarget[] = [];
    if (name && modulePath) {
      // An imported name can be a submodule itself (`from a import b` → a/b.py).
      const submodule = await moduleFile(doc, joinModulePath(modulePath, name)).catch(() => null);
      if (submodule) {
        others = [submodule];
      } else {
        const file = await moduleFile(doc, modulePath).catch(() => null);
        if (file) {
          const defs = await indexDefinitions(doc.path, name).catch(() => []);
          others = defs.filter((t) => t.path === file.path);
          if (!others.length) others = [file];
        }
      }
    }
    if (!others.length && name) {
      const targets = await indexDefinitions(doc.path, name).catch(() => []);
      others = targets.filter((t) => !(t.path === doc.path && rangeContains(t.range, pos)));
    }
    if (others.length === 1) {
      await navigateTo(others[0]!);
      return;
    }
    if (others.length > 1) {
      openPopup({
        kind: "list",
        anchor: caretAnchor(view, offset),
        title: chooserTitle(kind, name, others.length),
        items: await locationItems(others),
        pin: pinToFind(name ?? "", others),
      });
      return;
    }
    if (!(await executeAction("find.showUsages")) && !superseded()) showHint(view, "No usages found");
    return;
  }
  if (locs.length === 1) {
    await navigateTo(locs[0]!);
    // After the editor applied the navigation's selection (which dismisses hints).
    if (fromSyntax)
      setTimeout(() => {
        if (superseded()) return;
        const target = activeEditor()?.view;
        if (target) showHint(target, SYNTAX_NOTE, { timeout: 2500 });
      }, 150);
    return;
  }
  const name = nameAt(view, offset);
  const items = await locationItems(locs);
  if (superseded()) return;
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, offset),
    title: chooserTitle(kind, name, locs.length, fromSyntax),
    items,
    pin: pinToFind(name ?? "", locs),
  });
}

const WEB_LANGUAGES = new Set(["html", "css", "scss", "less", "vue", "svelte"]);

const WEB_SIGIL: Record<WebReferenceKind, string> = { class: ".", id: "#", anchor: "#", cssVariable: "" };

/**
 * `class` / `id` attributes to their CSS selectors, `href="#x"` to the element,
 * `var(--x)` to its declarations (no language server resolves these); false
 * when there is no such reference at `pos`.
 */
async function gotoWebReference(
  view: EditorView,
  doc: EditorDocContext,
  pos: Pos,
  offset: number,
  superseded: () => boolean,
): Promise<boolean> {
  if (!WEB_LANGUAGES.has(doc.language) || doc.virtual) return false;
  let found;
  try {
    await whenSynced(view);
    found = await lspRequest(() => commands.webGoto(doc.doc, pos));
  } catch (e) {
    console.debug("[web] goto", e);
    return false;
  }
  if (superseded()) return true;
  if (!found) return false;
  const { reference, targets } = found;
  const label = `${WEB_SIGIL[reference.kind]}${reference.name}`;
  if (!targets.length) showHint(view, `Cannot find declaration of '${label}'`);
  else if (targets.length === 1) await navigateTo(targets[0]!);
  else {
    const items = await locationItems(targets);
    if (superseded()) return true;
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, offset),
      title: tx`Choose Declaration of '${label}' (${targets.length} found)`,
      items,
      pin: pinToFind(label, targets),
    });
  }
  return true;
}

/** Follows the link, URL or file path at `offset`; false when there is none. */
async function followReferenceAt(
  view: EditorView,
  doc: EditorDocContext,
  offset: number,
  superseded: () => boolean,
): Promise<boolean> {
  const ref = await referenceAt(view, doc, offset);
  if (superseded()) return true;
  if (!ref) return false;
  try {
    if (ref.kind === "file" && ref.path === doc.path && ref.fragment) {
      const target = fragmentOffset(view.state.doc.toString(), doc.path, ref.fragment);
      if (target !== null) {
        view.dispatch({ selection: EditorSelection.cursor(target), effects: EditorView.scrollIntoView(target) });
        view.focus();
        return true;
      }
    }
    await followReference(ref);
  } catch (e) {
    if (!superseded()) showHint(view, e instanceof Error ? e.message : String(e), { tone: "error" });
  }
  return true;
}

/** Declaration targets from the structure service; null when it cannot answer for this file. */
async function gotoFallback(view: EditorView, doc: EditorDocContext, pos: Pos): Promise<DeclarationTarget[] | null> {
  try {
    await whenSynced(view);
    const text = view.state.doc;
    const fb = await declarationFallback(doc, text, pos);
    return fb.kind === "unsupported" ? null : fb.targets;
  } catch (e) {
    console.debug("[syntax] declaration fallback", e);
    return null;
  }
}

/**
 * The module path up to the caret's segment — `a.b` for `a.b.c` with the caret on `b`, with
 * the leading dots of a relative import — or null when the caret is not on a module path
 * (an imported name is not a path). Read from the line text: a segment names a file whether
 * or not a syntax tree is available.
 */
function importModuleName(view: EditorView, doc: EditorDocContext, offset: number): string | null {
  if (doc.virtual) return null;
  const line = view.state.doc.lineAt(offset);
  const col = offset - line.from;
  const prefixTo = (path: string, at: number) => {
    const cut = Math.min(Math.max(0, col - at), path.length);
    let end = cut;
    while (end < path.length && path[end] !== ".") end++;
    return path.slice(0, end);
  };
  const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line.text);
  if (from?.[1]) {
    const at = line.text.indexOf(from[1], from.index);
    if (col >= at && col <= at + from[1].length) return prefixTo(from[1], at) || null;
  }
  const plain = /^\s*import\s+([\w.]+)/.exec(line.text);
  if (plain?.[1]) {
    const at = line.text.indexOf(plain[1], plain.index);
    if (col >= at && col <= at + plain[1].length) return prefixTo(plain[1], at) || null;
  }
  return null;
}

/** The file a dotted module path names, in the roots the document may navigate into. */
async function moduleFile(doc: EditorDocContext, name: string): Promise<DeclarationTarget | null> {
  const path = await lspRequest(() => commands.navResolveModule(name, doc.path)).catch(() => null);
  return path ? { path, range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } } } : null;
}

/**
 * The full module path an import binds names from — `a.b` of `from a.b import c` (with the
 * relative dots), or the dotted path of a plain `import`. Reads through a parenthesised
 * `from … import (…)` so a caret on a listed name finds its module. Null off an import.
 */
function importedModulePath(view: EditorView, offset: number): string | null {
  const doc = view.state.doc;
  let line = doc.lineAt(offset);
  for (let hops = 0; ; hops++) {
    const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line.text);
    if (from?.[1]) return from[1];
    const plain = /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*(?:#.*)?$/.exec(line.text);
    if (plain?.[1]) return plain[1];
    if (line.number === 1 || hops > 20) return null;
    const prev = doc.line(line.number - 1);
    // A listed name continues an import above; anything else does not.
    if (!/[,(]\s*$/.test(prev.text) || !/^[\w*,\s()]*$/.test(line.text)) return null;
    line = prev;
  }
}

/** The name an import binds at the caret — the original when the caret is on its alias. */
function importedDeclarationName(view: EditorView, offset: number): string | null {
  const word = navigationWord(view, offset);
  if (!word) return null;
  const text = view.state.sliceDoc(word.from, word.to);
  const alias = new RegExp(`(\\w+)\\s+as\\s+${text}\\b`).exec(view.state.doc.lineAt(offset).text);
  return alias?.[1] ?? text;
}

/** `from . import x` joins as `.x`; `from a.b import c` as `a.b.c`. */
function joinModulePath(module: string, name: string): string {
  return module.endsWith(".") ? `${module}${name}` : `${module}.${name}`;
}

// ---------------------------------------------------------------------------
// ⌘-hover link + ⌘-click

type NavInfo = NonNullable<ReturnType<typeof declarationSummary>>;

interface LinkState {
  from: number;
  to: number;
  /** Brief declaration info shown above the underlined element (IDEA's ⌘-hover tooltip). */
  info: NavInfo | null;
}

const setLink = StateEffect.define<LinkState | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<LinkState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLink)) return e.value;
    return tr.docChanged ? null : value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => (v ? Decoration.set([linkMark.range(v.from, v.to)]) : Decoration.none)),
    showTooltip.from(f, (v): Tooltip | null => {
      const info = v?.info;
      if (!v || !info) return null;
      return {
        pos: v.from,
        above: true,
        create: (view) => {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover cm-lsp-nav-info";
          if ("code" in info)
            dom.appendChild(renderCode(info.code, info.language ?? docOf(view)?.uiMode ?? null, "cm-lsp-code"));
          else dom.textContent = info.text;
          return { dom };
        },
      };
    }),
  ],
});

/** What ⌘-hover underlines: a whole link, URL or path (always navigable), else the word. */
function linkAt(view: EditorView, x: number, y: number): { from: number; to: number; link: boolean } | null {
  const pos = view.posAtCoords({ x, y }, false);
  if (pos == null) return null;
  const links = knownLinks(view);
  const ref =
    (links && linkReference(view.state.doc, links, pos, docOf(view)?.path ?? "")) ?? textReference(view.state.doc, pos);
  if (ref) return { from: ref.from, to: ref.to, link: true };
  const word = navigationWord(view, pos);
  return word && word.from < word.to ? { from: word.from, to: word.to, link: false } : null;
}

/**
 * Whether ⌘-click at `offset` would navigate somewhere, with the declaration
 * info to show; null when there is no target (no underline then, as in IDEA).
 */
async function probeNavigation(
  view: EditorView,
  offset: number,
): Promise<{ info: NavInfo | null; plugin?: NavigationMatch } | null> {
  const plugin = await contributedNavigation(view, offset).catch(() => null);
  if (plugin) return { info: null, plugin };
  const doc = docOf(view);
  let navigable = !!contributedAt<ContributedDefinition>(view.state, CONTRIBUTED_DEFINITION, offset);
  if (!navigable && doc) {
    const pos = offsetToPos(view.state.doc, offset);
    let fromSyntax = false;
    try {
      navigable = (await requestNavigation(view, offset, "definition")).length > 0;
    } catch (e) {
      if (!isUnavailable(e)) throw e;
      navigable = !!(await gotoFallback(view, doc, pos))?.length;
      fromSyntax = true;
    }
    if (!navigable && WEB_LANGUAGES.has(doc.language) && !doc.virtual)
      navigable = !!(await lspRequest(() => commands.webGoto(doc.doc, pos)).catch(() => null))?.targets.length;
    // The index answers across dependency roots too (unresolved imports), but a module path
    // segment is a file rather than a name.
    if (!navigable && !fromSyntax) {
      const moduleName = importModuleName(view, doc, offset);
      if (moduleName) navigable = !!(await moduleFile(doc, moduleName).catch(() => null));
      else {
        const word = navigationWord(view, offset);
        const name = word ? view.state.sliceDoc(word.from, word.to) : null;
        const targets = name ? await indexDefinitions(doc.path, name).catch(() => []) : [];
        navigable = targets.length > 0;
      }
    }
  }
  if (!navigable) return null;
  return { info: null };
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    last: { x: number; y: number } | null = null;
    /** Probe results per word (`from:to`) for the current document. */
    private probed = new Map<
      string,
      { result: { info: NavInfo | null; plugin?: NavigationMatch } | null; at: number }
    >();
    private revision = configurationNavigationRevision();
    private probedDoc: Text | null = null;
    private providerEpoch = -1;
    private probing: string | null = null;
    private off: () => void;
    private offProviders: () => void;
    private disposed = false;
    private hovered: string | null = null;
    private probeVersion = 0;
    private probeTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {
      // Window-wide, so ⌘/Ctrl over an unfocused editor underlines too; released anywhere clears it.
      const offModifier = onNavigationModifier((held) => {
        if (!held || this.last) this.show(held);
      });
      this.offProviders = onNavigationProvidersChanged(() => {
        if (this.disposed) return;
        this.probeVersion++;
        clearTimeout(this.probeTimer);
        this.probing = null;
        this.probed.clear();
        this.set(null);
        if (this.last) this.show(navigationModifierHeld());
      });
      // IDEA's macOS "Force touch" shortcut: a force click navigates like ⌘-click
      // (the keyboard dispatcher keeps the system Look Up popover away).
      const onForceDown = (e: Event) => {
        const m = e as MouseEvent;
        if (m.metaKey || m.ctrlKey || m.altKey || m.shiftKey) return;
        if (navigateFromPointer(view, m)) m.preventDefault();
      };
      view.contentDOM.addEventListener("webkitmouseforcedown", onForceDown);
      this.off = () => {
        offModifier();
        view.contentDOM.removeEventListener("webkitmouseforcedown", onForceDown);
      };
    }
    destroy() {
      this.off();
      this.offProviders();
      this.disposed = true;
      this.probeVersion++;
      clearTimeout(this.probeTimer);
    }
    private set(value: LinkState | null) {
      const current = this.view.state.field(linkField);
      if (
        current === value ||
        (current && value && current.from === value.from && current.to === value.to && current.info === value.info)
      )
        return;
      if (!current && !value) return;
      this.view.dispatch({ effects: setLink.of(value) });
    }
    show(meta: boolean) {
      const view = this.view;
      const doc = meta ? docOf(view) : null;
      // Underline whole links once the server's links are in.
      if (doc && !doc.virtual && !knownLinks(view))
        void documentLinks(view, doc).then(() => {
          if (!this.disposed && view.state.field(linkField)) this.show(true);
        });
      const target = meta && this.last ? linkAt(view, this.last.x, this.last.y) : null;
      const hovered = target ? `${target.from}:${target.to}` : null;
      if (hovered !== this.hovered) {
        this.hovered = hovered;
        this.probeVersion++;
        clearTimeout(this.probeTimer);
        this.probing = null;
      }
      if (!target) {
        this.probeVersion++;
        clearTimeout(this.probeTimer);
        this.probing = null;
        this.set(null);
        return;
      }
      if (target.link) {
        this.probing = null;
        this.set({ from: target.from, to: target.to, info: null });
        return;
      }
      if (
        this.probedDoc !== view.state.doc ||
        this.providerEpoch !== navigationEpoch() ||
        this.revision !== configurationNavigationRevision()
      ) {
        this.providerEpoch = navigationEpoch();
        this.revision = configurationNavigationRevision();
        this.probeVersion++;
        clearTimeout(this.probeTimer);
        this.probing = null;
        this.probed.clear();
        this.probedDoc = view.state.doc;
      }
      const key = `${target.from}:${target.to}`;
      const hit = this.probed.get(key);
      // Configuration targets appear as the Java import progresses: they expire, and a
      // remembered target must still be in the shared results. Other results last until an edit.
      const config = isConfigurationDocument(view);
      if (
        hit &&
        (!config || Date.now() - hit.at < (hit.result ? CONFIGURATION_NAVIGATION_MAX_AGE : 1000)) &&
        (!hit.result || !config || hasConfigurationNavigation(view, target.from))
      ) {
        const found = hit.result;
        this.set(
          found
            ? { from: found.plugin?.from ?? target.from, to: found.plugin?.to ?? target.to, info: found.info }
            : null,
        );
        return;
      }
      const current = view.state.field(linkField);
      if (current && (current.from !== target.from || current.to !== target.to)) this.set(null);
      if (this.probing === key) return;
      this.probing = key;
      const version = ++this.probeVersion;
      clearTimeout(this.probeTimer);
      // A timed-out probe must be retryable, rather than cached as "no target".
      this.probeTimer = setTimeout(() => {
        if (this.probeVersion === version) {
          this.probeVersion++;
          this.probing = null;
        }
      }, 3000);
      const docAt = view.state.doc;
      const epochAt = navigationEpoch();
      const revision = this.revision;
      void probeNavigation(view, target.from)
        .then((result) => {
          if (
            this.disposed ||
            view.state.doc !== docAt ||
            this.probeVersion !== version ||
            epochAt !== navigationEpoch() ||
            revision !== configurationNavigationRevision()
          )
            return;
          clearTimeout(this.probeTimer);
          if (this.probed.size >= 128) this.probed.delete(this.probed.keys().next().value!);
          this.probed.set(key, { result, at: Date.now() });
          if (this.probing !== key) return;
          this.probing = null;
          if (!result) this.set(null);
          if (result) {
            this.set({ from: result.plugin?.from ?? target.from, to: result.plugin?.to ?? target.to, info: null });
            // Configuration navigation is a link gesture. Plain hover still
            // shows schema/type documentation; do not cover the key with it here.
            if (result.plugin || isConfigurationDocument(view)) return;
            // Documentation must never delay the link cursor or underline.
            void requestHover(view, target.from)
              .then((hover) => {
                if (this.disposed || view.state.doc !== docAt || this.probeVersion !== version || !hover) return;
                const info = declarationSummary(hover.contents);
                this.probed.set(key, { result: { info }, at: Date.now() });
                this.set({ from: target.from, to: target.to, info });
              })
              .catch(() => {});
          }
        })
        .catch(() => {
          if (this.disposed || this.probeVersion !== version) return;
          clearTimeout(this.probeTimer);
          this.probing = null;
          // Cancellation and server errors are transient, not negative results.
        });
    }
  },
  {
    eventHandlers: {
      mousemove(e) {
        // Not through a popup or an inlay hint (which navigates on its own ⌘-click) to the text under it.
        const over = e.target instanceof Element ? e.target : null;
        this.last = over?.closest(".cm-tooltip, .cm-lsp-inlay") ? null : { x: e.clientX, y: e.clientY };
        this.show(isNavigationGesture(e));
      },
      mouseleave() {
        this.last = null;
        this.show(false);
      },
      mousedown(e, view) {
        if (e.button !== 0 && e.button !== 1) return false;
        if (isAddCaretGesture(e)) return false;
        if (
          dispatchMouseShortcut(e, () => {
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
            if (pos == null) return false;
            view.dispatch({ selection: EditorSelection.cursor(pos), effects: setLink.of(null) });
            view.focus();
            return true;
          })
        ) {
          e.preventDefault();
          return true;
        }
        // IDEA parity: middle button navigates on a plain click, without the modifier.
        if (e.button === 1 ? e.metaKey || e.ctrlKey || e.altKey || e.shiftKey : !isNavigationGesture(e)) return false;
        if (!navigateFromPointer(view, e)) return false;
        e.preventDefault();
        return true;
      },
    },
  },
);

/** Puts the caret under the pointer and goes to the declaration there, like a ⌘/Ctrl-click. */
function navigateFromPointer(view: EditorView, e: MouseEvent): boolean {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
  if (pos == null) return false;
  view.dispatch({ selection: EditorSelection.cursor(pos), effects: setLink.of(null) });
  view.focus();
  void gotoTargets(view, "definition", pos);
  return true;
}

// ---------------------------------------------------------------------------
// Document highlights

interface HighlightState {
  deco: DecorationSet;
  sticky: boolean;
}

type HighlightItem = { from: number; to: number; kind: Highlight["kind"] };

const setHighlights = StateEffect.define<{ items: HighlightItem[]; sticky: boolean }>();

const marks = {
  text: Decoration.mark({ class: "cm-lsp-occurrence" }),
  read: Decoration.mark({ class: "cm-lsp-occurrence cm-lsp-occurrence-read" }),
  write: Decoration.mark({ class: "cm-lsp-occurrence cm-lsp-occurrence-write" }),
};

const highlightField = StateField.define<HighlightState>({
  create: () => ({ deco: Decoration.none, sticky: false }),
  update(value, tr) {
    for (const e of tr.effects)
      if (e.is(setHighlights))
        return {
          deco: Decoration.set(
            e.value.items.filter((i) => i.from < i.to).map((i) => marks[i.kind].range(i.from, i.to)),
            true,
          ),
          sticky: e.value.sticky,
        };
    // Kept (mapped) until recomputed; ⌘⇧F7 highlights survive edits until Escape.
    if (tr.docChanged) return { deco: value.deco.map(tr.changes), sticky: value.sticky };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** IDEA's status bar text while ⌘⇧F7 highlights are shown. */
export const useUsagesStatus = create<{ text: string | null; owner: EditorView | null }>(() => ({
  text: null,
  owner: null,
}));

function setUsagesStatus(owner: EditorView | null, text: string | null) {
  useUsagesStatus.setState({ owner, text });
}

export function usagesStatusText(count: number, name: string, toggleKeys: string | null): string {
  const again = toggleKeys ? `press ${toggleKeys} again to remove the highlighting, ` : "";
  return `${count} ${count === 1 ? "usage" : "usages"} of ${name} found (${again}Escape to remove all highlighting)`;
}

function clearHighlights(view: EditorView) {
  view.dispatch({ effects: setHighlights.of({ items: [], sticky: false }) });
  if (useUsagesStatus.getState().owner === view) setUsagesStatus(null, null);
}

async function fetchHighlights(view: EditorView, sticky: boolean) {
  const doc = docOf(view);
  if (!doc) return;
  await whenSynced(view);
  const state = view.state;
  const head = state.selection.main.head;
  const stale = () => view.state.doc !== state.doc || view.state.selection.main.head !== head;
  const apply = (items: HighlightItem[]) => {
    view.dispatch({ effects: setHighlights.of({ items, sticky: sticky && items.length > 0 }) });
    if (!sticky) return;
    if (!items.length) {
      if (useUsagesStatus.getState().owner === view) setUsagesStatus(null, null);
      return;
    }
    const at = items.find((i) => i.from <= head && head <= i.to) ?? state.wordAt(head);
    const name = at ? state.sliceDoc(at.from, at.to) : "";
    setUsagesStatus(
      view,
      usagesStatusText(items.length, name ? `'${name}'` : "the element", shortcutLabel("find.highlightUsages") ?? null),
    );
  };
  let lspError: unknown = null;
  if (!highlightsBackoff.active(doc.doc)) {
    try {
      const items = await lspRequest(() => commands.lspDocumentHighlights(doc.doc, offsetToPos(state.doc, head)));
      if (stale()) return;
      if (sticky && !items.length) showHint(view, "No usages found in file");
      apply(items.map((h) => ({ ...rangeToOffsets(state.doc, h.range), kind: h.kind })));
      return;
    } catch (e) {
      if (isCancelled(e)) return;
      if (isUnavailable(e)) highlightsBackoff.mark(doc.doc);
      lspError = e;
    }
  }
  // No usable server: only a certain local's same-scope occurrences (anything wider is too noisy to guess).
  const local = await syntaxHighlights(view, doc, head);
  if (stale()) return;
  if (local) {
    if (sticky) showHint(view, SYNTAX_NOTE, { timeout: 2500 });
    apply(local.map((h) => ({ ...rangeToOffsets(state.doc, h.range), kind: h.kind })));
    return;
  }
  if (lspError) reportLspError(view, lspError, sticky);
  else if (sticky) showHint(view, NO_SERVER);
  // Drop stale marks from an earlier caret position.
  if (view.state.field(highlightField).deco.size) apply([]);
}

async function syntaxHighlights(view: EditorView, doc: EditorDocContext, head: number) {
  try {
    if (!(await structure.support(doc.language)).locals) return null;
    await whenSynced(view);
    if (view.state.selection.main.head !== head) return null;
    return localHighlights(await structure.locals(doc.doc, offsetToPos(view.state.doc, head)));
  } catch (e) {
    if (!isCancelled(e)) console.debug("[syntax] highlight fallback", e);
    return null;
  }
}

/** ⌘⇧F7: highlight usages of the symbol at the caret until Escape; again on a highlighted usage removes them. */
export function highlightUsages(view: EditorView) {
  const st = view.state.field(highlightField, false);
  const head = view.state.selection.main.head;
  let onUsage = false;
  st?.deco.between(head, head, (from, to) => {
    if (from <= head && head <= to) onUsage = true;
  });
  if (st?.sticky && onUsage) {
    clearHighlights(view);
    return;
  }
  void fetchHighlights(view, true);
}

/**
 * ⌃⌥↓ / ⌃⌥↑: the next (previous) highlighted usage of the element at the caret,
 * wrapping, with the caret at the same offset inside it.
 */
export function gotoHighlightedUsage(view: EditorView, dir: 1 | -1): boolean {
  const st = view.state.field(highlightField, false);
  const ranges: { from: number; to: number }[] = [];
  st?.deco.between(0, view.state.doc.length, (from, to) => void ranges.push({ from, to }));
  const head = view.state.selection.main.head;
  const current = ranges.findIndex((r) => r.from <= head && head <= r.to);
  if (ranges.length < 2 || current < 0) return false;
  const target = ranges[(current + dir + ranges.length) % ranges.length]!;
  const pos = Math.min(target.from + (head - ranges[current]!.from), target.to);
  view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true, userEvent: "select.navigate" });
  return true;
}

const highlightPlugin = ViewPlugin.fromClass(
  class {
    private request = debounce(() => void fetchHighlights(this.view, false), 300);
    constructor(private view: EditorView) {}
    update(u: ViewUpdate) {
      // Recomputed after caret moves and, like IDEA's daemon, after edits.
      if (!u.selectionSet && !u.docChanged) return;
      const st = u.state.field(highlightField);
      if (st.sticky) {
        this.request.cancel();
        return;
      }
      const clear = () => {
        this.request.cancel();
        if (st.deco.size)
          queueMicrotask(() => this.view.dispatch({ effects: setHighlights.of({ items: [], sticky: false }) }));
      };
      // Code Editing › "Usages of element at caret".
      if (!editorPrefs().codeEditing.highlightUsages || !u.state.selection.main.empty) {
        clear();
        return;
      }
      this.request();
    }
    destroy() {
      this.request.cancel();
      if (useUsagesStatus.getState().owner === this.view) setUsagesStatus(null, null);
    }
  },
);

export function navigationExtension(): Extension {
  return [
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        editedAt.set(u.view, performance.now());
        invalidateConfigurationNavigation();
      }
    }),
    linkField,
    linkPlugin,
    highlightField,
    highlightPlugin,
    Prec.high(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            const st = view.state.field(highlightField, false);
            if (!st?.sticky) return false;
            clearHighlights(view);
            return true;
          },
        },
      ]),
    ),
  ];
}
