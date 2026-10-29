/**
 * Go to declaration / implementation / type declaration (⌘B, ⌥⌘B, ⇧⌘B and
 * ⌘-click with a link underline while ⌘ is held), the multiple-targets
 * chooser, and document highlights (occurrences of the symbol at the caret,
 * plus the sticky find.highlightUsages variant).
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
import {
  commands,
  isCancelled,
  type GotoKind,
  type Highlight,
  type Location,
  type Pos,
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
import { offsetToPos, rangeToOffsets } from "./positions";
import {
  SYNTAX_NOTE,
  declarationFallback,
  isSelfTarget,
  localHighlights,
  type DeclarationTarget,
} from "./syntaxFallback";
import { showHint, showPendingHint } from "./hint";
import { caretAnchor, openPopup, type ListPopupItem } from "./popupStore";
import { identifierAt, readManyFileLines } from "./files";
import { documentLinks, followReference, knownLinks, linkReference, referenceAt, textReference } from "./links";
import { featureBackoff } from "./availability";
import { requestHover } from "./hover";
import { declarationSummary, renderCode } from "./markdown";
import { editorPrefs } from "@/platform/editorSettings";
import { isVirtualUri, virtualContainer } from "@/platform/virtualDocs";
import { shortcutLabel } from "@/platform/keymap";
import { isNavigationGesture, onNavigationModifier } from "@/platform/navigationModifier";
import { create } from "zustand";
import { tx } from "@/platform/i18n";

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

/** Popup items for locations, with a one-line source preview each. */
export async function locationItems(locs: readonly DeclarationTarget[]): Promise<ListPopupItem[]> {
  const files = await readManyFileLines(locs.map((l) => l.path));
  const root = useProject.getState().project?.root ?? "";
  return locs.map((l, i) => {
    const where = `${isVirtualUri(l.path) ? virtualContainer(l.path) : relativePath(root, l.path)}:${l.range.start.line + 1}`;
    const preview = files.get(l.path)?.[l.range.start.line]?.trim();
    // Index symbols (syntax fallback): "name  container · file:line", like IDEA's chooser.
    if (l.kind && l.name)
      return {
        id: `${i}`,
        label: l.name,
        detail: l.container ? `${l.container} · ${where}` : where,
        preview,
        symbol: l.kind,
        run: () => navigateTo(l),
      };
    // Server targets: the declared name (speed search matches it), file and line after it.
    const name = identifierAt(files.get(l.path)?.[l.range.start.line] ?? "", l.range.start.col);
    return {
      id: `${i}`,
      label: name ?? basename(l.path),
      detail: name ? `${basename(l.path)} · ${where}` : where,
      preview,
      icon: fileIconName(basename(l.path)),
      run: () => navigateTo(l),
    };
  });
}

/** "Choose Implementation of foo (3 found)". */
export function chooserTitle(kind: GotoKind, name: string | null, count: number, fromSyntax = false): string {
  return `${TITLES[kind]}${name ? ` of ${name}` : ""} (${count} found${fromSyntax ? ", based on syntax" : ""})`;
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
async function gotoAfterEdits(view: EditorView, request: () => Promise<DeclarationTarget[]>) {
  for (let attempt = 0; ; attempt++) {
    const locs = await request();
    if (locs.length || attempt >= 3 || performance.now() - (editedAt.get(view) ?? -Infinity) > 1500) return locs;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function gotoTargets(view: EditorView, kind: GotoKind, at?: number) {
  const offset = at ?? view.state.selection.main.head;
  if (kind === "definition" || kind === "declaration") {
    const own = contributedAt<ContributedDefinition>(view.state, CONTRIBUTED_DEFINITION, offset);
    if (own?.(view, offset)) return;
  }
  const doc = docOf(view);
  if (!doc) return;
  const pos = offsetToPos(view.state.doc, offset);
  let locs: DeclarationTarget[];
  let fromSyntax = false;
  const declaration = kind === "definition" || kind === "declaration";
  let serverDown = false;
  try {
    const done = showPendingHint(view, tx`Finding navigation target…`);
    try {
      locs = dedupeLocations(await gotoAfterEdits(view, () => lspRequest(() => commands.lspGoto(doc.doc, pos, kind))));
    } finally {
      done();
    }
  } catch (e) {
    if (isCancelled(e) || !declaration) {
      reportLspError(view, e, true);
      return;
    }
    // Web references and links need no server.
    if ((await gotoWebReference(view, doc, pos, offset)) || (await followReferenceAt(view, doc, offset))) return;
    serverDown = isUnavailable(e);
    // Dumb mode: the server is not ready / failing — answer from the syntax tree.
    const fb = await gotoFallback(view, doc, pos);
    if (!fb) {
      reportLspError(view, e, true);
      return;
    }
    locs = fb;
    fromSyntax = true;
  }
  if (!locs.length) {
    // The server has no definition here: a link (`href`, `#include`, Markdown) or a file path.
    if (
      declaration &&
      !fromSyntax &&
      ((await gotoWebReference(view, doc, pos, offset)) || (await followReferenceAt(view, doc, offset)))
    )
      return;
    showHint(view, serverDown ? `${NOT_FOUND[kind]}: no language server is running for this file` : NOT_FOUND[kind]);
    return;
  }
  // IDEA: ⌘B on a declaration shows its usages.
  if (kind === "definition" && isSelfTarget(locs, doc.path, pos)) {
    if (!(await executeAction("find.showUsages"))) showHint(view, "No usages found");
    return;
  }
  if (locs.length === 1) {
    await navigateTo(locs[0]!);
    // After the editor applied the navigation's selection (which dismisses hints).
    if (fromSyntax)
      setTimeout(() => {
        const target = activeEditor()?.view;
        if (target) showHint(target, SYNTAX_NOTE, { timeout: 2500 });
      }, 150);
    return;
  }
  const word = view.state.wordAt(offset);
  const name = word ? view.state.sliceDoc(word.from, word.to) : null;
  openPopup({
    kind: "list",
    anchor: caretAnchor(view, offset),
    title: chooserTitle(kind, name, locs.length, fromSyntax),
    items: await locationItems(locs),
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
async function gotoWebReference(view: EditorView, doc: EditorDocContext, pos: Pos, offset: number): Promise<boolean> {
  if (!WEB_LANGUAGES.has(doc.language) || doc.virtual) return false;
  let found;
  try {
    await whenSynced(view);
    found = await lspRequest(() => commands.webGoto(doc.doc, pos));
  } catch (e) {
    console.debug("[web] goto", e);
    return false;
  }
  if (!found) return false;
  const { reference, targets } = found;
  const label = `${WEB_SIGIL[reference.kind]}${reference.name}`;
  if (!targets.length) showHint(view, `Cannot find declaration of '${label}'`);
  else if (targets.length === 1) await navigateTo(targets[0]!);
  else
    openPopup({
      kind: "list",
      anchor: caretAnchor(view, offset),
      title: tx`Choose Declaration of '${label}' (${targets.length} found)`,
      items: await locationItems(targets),
      pin: pinToFind(label, targets),
    });
  return true;
}

/** Follows the link, URL or file path at `offset`; false when there is none. */
async function followReferenceAt(view: EditorView, doc: EditorDocContext, offset: number): Promise<boolean> {
  const ref = await referenceAt(view, doc, offset);
  if (!ref) return false;
  try {
    await followReference(ref);
  } catch (e) {
    showHint(view, e instanceof Error ? e.message : String(e), { tone: "error" });
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
  const ref = (links && linkReference(view.state.doc, links, pos)) ?? textReference(view.state.doc, pos);
  if (ref) return { from: ref.from, to: ref.to, link: true };
  const word = view.state.wordAt(pos);
  return word && word.from < word.to ? { from: word.from, to: word.to, link: false } : null;
}

/**
 * Whether ⌘-click at `offset` would navigate somewhere, with the declaration
 * info to show; null when there is no target (no underline then, as in IDEA).
 */
async function probeNavigation(view: EditorView, offset: number): Promise<{ info: NavInfo | null } | null> {
  const doc = docOf(view);
  let navigable = !!contributedAt<ContributedDefinition>(view.state, CONTRIBUTED_DEFINITION, offset);
  if (!navigable && doc) {
    const pos = offsetToPos(view.state.doc, offset);
    try {
      navigable = (await lspRequest(() => commands.lspGoto(doc.doc, pos, "definition"))).length > 0;
    } catch (e) {
      if (!isUnavailable(e)) throw e;
      navigable = !!(await gotoFallback(view, doc, pos))?.length;
    }
    if (!navigable && WEB_LANGUAGES.has(doc.language) && !doc.virtual)
      navigable = !!(await lspRequest(() => commands.webGoto(doc.doc, pos)).catch(() => null))?.targets.length;
  }
  if (!navigable) return null;
  return { info: null };
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    last: { x: number; y: number } | null = null;
    /** Probe results per word (`from:to`) for the current document. */
    private probed = new Map<string, { info: NavInfo | null } | null>();
    private probedDoc: Text | null = null;
    private probing: string | null = null;
    private off: () => void;
    private disposed = false;
    private hovered: string | null = null;
    private probeVersion = 0;
    private probeTimer: ReturnType<typeof setTimeout> | undefined;
    constructor(readonly view: EditorView) {
      // Window-wide, so ⌘/Ctrl over an unfocused editor underlines too; released anywhere clears it.
      this.off = onNavigationModifier((held) => {
        if (!held || this.last) this.show(held);
      });
    }
    destroy() {
      this.off();
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
      if (this.probedDoc !== view.state.doc) {
        this.probed.clear();
        this.probedDoc = view.state.doc;
      }
      const key = `${target.from}:${target.to}`;
      if (this.probed.has(key)) {
        const hit = this.probed.get(key);
        this.set(hit ? { from: target.from, to: target.to, info: hit.info } : null);
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
      void probeNavigation(view, target.from)
        .then((result) => {
          if (this.disposed || view.state.doc !== docAt || this.probeVersion !== version) return;
          clearTimeout(this.probeTimer);
          this.probed.set(key, result);
          if (this.probing !== key) return;
          this.probing = null;
          if (result) {
            this.set({ from: target.from, to: target.to, info: null });
            // Documentation must never delay the link cursor or underline.
            void requestHover(view, target.from)
              .then((hover) => {
                if (this.disposed || view.state.doc !== docAt || this.probeVersion !== version || !hover) return;
                const info = declarationSummary(hover.contents);
                this.probed.set(key, { info });
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
        if (e.button !== 0 || !isNavigationGesture(e)) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
        if (pos == null) return false;
        e.preventDefault();
        view.dispatch({ selection: EditorSelection.cursor(pos), effects: setLink.of(null) });
        view.focus();
        void gotoTargets(view, "definition", pos);
        return true;
      },
    },
  },
);

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
      if (u.docChanged) editedAt.set(u.view, performance.now());
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
