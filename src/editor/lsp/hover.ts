/**
 * Hover tooltip (500ms): diagnostics under the pointer + quick documentation,
 * plus the explicit actions code.quickDocumentation (F1, sticky popup with
 * history, `docs.ts`) and code.quickDefinition (⌥Space, definition source popup).
 */
import { EditorSelection } from "@codemirror/state";
import { closeHoverTooltips, hasHoverTooltips, hoverTooltip, ViewPlugin, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import {
  commands,
  isTauri,
  nextRequestId,
  type Hover,
  type Location,
  type Pos,
  type Range,
  type RequestId,
} from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { shortcutLabel } from "@/platform/keymap";
import { diagnosticsAt, type PlacedDiagnostic } from "./diagnostics";
import { isEmptyMarkup, languageForPath, renderMarkup } from "./markdown";
import { selectableText } from "@/ui/selectableText";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, focusPopup, openPopup, useLspPopup, type DefinitionTarget, type DocEntry } from "./popupStore";
import { selectedLookupDoc, showLookupDocs } from "./completion";
import { identifierAt, readFileLines, withDocument } from "./files";
import { docWindowVisible, moveDocPopupToWindow, showInDocWindow } from "./docs";
import { structure } from "@/editor/structure";
import { basename } from "@/platform/project";
import { iconNode } from "./iconMarkup";
import { applyCodeAction, quickFixesAt } from "./intentions";
import { editorPrefs } from "@/platform/editorSettings";
import { CONTRIBUTED_HOVER, contributedAt, type ContributedHover } from "@/editor/api";
import { navigationModifierHeld, onNavigationModifier, pointerTarget } from "@/platform/navigationModifier";
import { phpConstructAt } from "./phpConstructs";

let hoverRequest: RequestId | null = null;

export async function requestHover(view: EditorView, pos: number): Promise<Hover | null> {
  const own = contributedAt<ContributedHover>(view.state, CONTRIBUTED_HOVER, pos);
  if (own) {
    const h = own(view.state, pos);
    if (!h) return null;
    const range = { start: offsetToPos(view.state.doc, h.from), end: offsetToPos(view.state.doc, h.to) };
    return { contents: { kind: "markdown", value: h.markdown }, range };
  }
  const doc = docOf(view);
  if (!doc) return null;
  const construct = phpConstructAt(view.state, pos, doc.language);
  if (construct)
    return {
      contents: { kind: "markdown", value: construct.markdown },
      range: { start: offsetToPos(view.state.doc, construct.from), end: offsetToPos(view.state.doc, construct.to) },
    };
  if (hoverRequest !== null && isTauri()) void commands.cancelRequest(hoverRequest);
  const id = (hoverRequest = nextRequestId());
  try {
    const h = await lspRequest(
      () => commands.lspHover(id, doc.doc, offsetToPos(view.state.doc, pos)),
      () => hoverRequest === id,
    );
    return h && !isEmptyMarkup(h.contents) ? h : null;
  } finally {
    if (hoverRequest === id) hoverRequest = null;
  }
}

function renderDiagnostics(view: EditorView, diags: PlacedDiagnostic[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-lsp-hover-diagnostics";
  for (const { diagnostic: d, from, to } of diags) {
    const row = document.createElement("div");
    row.className = `cm-lsp-diag cm-lsp-diag-${d.severity}`;
    row.appendChild(
      iconNode(
        d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
        16,
        "cm-lsp-diag-icon",
      ),
    );
    const msg = document.createElement("div");
    msg.className = "cm-lsp-diag-message";
    msg.textContent = d.message;
    row.appendChild(msg);
    const meta = document.createElement("div");
    meta.className = "cm-lsp-diag-meta";
    if (d.source) {
      const src = document.createElement("span");
      src.className = "cm-lsp-diag-source";
      src.textContent = d.source;
      meta.appendChild(src);
    }
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "cm-lsp-link-button";
    const keys = shortcutLabel("code.showIntentions");
    fix.textContent = keys ? `More actions… ${keys}` : "More actions…";
    if (d.severity === "error" || d.severity === "warning") offerQuickFix(view, meta, fix, from, to);
    fix.addEventListener("mousedown", (e) => e.preventDefault());
    fix.addEventListener("click", () => {
      view.dispatch({ selection: EditorSelection.cursor(from) });
      view.focus();
      void executeAction("code.showIntentions");
    });
    meta.appendChild(fix);
    row.appendChild(meta);
    box.appendChild(row);
  }
  return box;
}

/** IDEA's hover link to the problem's preferred quick fix, shown once the server named one. */
function offerQuickFix(view: EditorView, meta: HTMLElement, before: HTMLElement, from: number, to: number) {
  const doc = view.state.doc;
  void quickFixesAt(view, from, to)
    .then(([action]) => {
      if (!action || view.state.doc !== doc || !before.isConnected) return;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "cm-lsp-link-button";
      const keys = shortcutLabel("code.applyQuickFix");
      link.textContent = keys ? `${action.title} ${keys}` : action.title;
      link.addEventListener("mousedown", (e) => e.preventDefault());
      link.addEventListener("click", () => {
        view.dispatch({ effects: closeHoverTooltips });
        view.focus();
        void applyCodeAction(view, action);
      });
      meta.insertBefore(link, before);
    })
    .catch(() => {});
}

/**
 * Whether the plain hover (problems + quick documentation) stays out: while
 * ⌘/Ctrl is held the ⌘-hover link and its brief info (`navigation.ts`) own the
 * pointer, as in IDEA; and over an inlay hint, which has its own tooltip.
 */
export function hoverYields(): boolean {
  return navigationModifierHeld() || !!pointerTarget()?.closest?.(".cm-lsp-inlay");
}

/** Problems always; quick documentation per Settings › Editor › Code Editing. */
export async function hoverSource(view: EditorView, pos: number) {
  if (hoverYields()) return null;
  const diags = diagnosticsAt(view, pos);
  let hover: Hover | null = null;
  if (editorPrefs().codeEditing.quickDocOnHover)
    try {
      hover = await requestHover(view, pos);
    } catch (e) {
      reportLspError(view, e, false);
    }
  // ⌘/Ctrl pressed while the server answered.
  if (hoverYields()) return null;
  if (!diags.length && !hover) return null;
  let from = pos,
    to = pos;
  if (hover?.range) ({ from, to } = rangeToOffsets(view.state.doc, hover.range));
  else if (diags.length) ({ from, to } = diags[0]!);
  else {
    const word = view.state.wordAt(pos);
    if (word) ({ from, to } = word);
  }
  const lang = docOf(view)?.uiMode ?? null;
  return {
    pos: from,
    end: to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = `cm-lsp-hover ${selectableText}`;
      if (diags.length) dom.appendChild(renderDiagnostics(view, diags));
      if (hover) dom.appendChild(renderMarkup(hover.contents, lang));
      return { dom };
    },
  };
}

/**
 * Pressing ⌘/Ctrl closes the open hover popups (documentation, problems,
 * debugger values) so the ⌘-hover info replaces them instead of stacking;
 * a popup the pointer is in stays (selecting text in it and copying).
 */
const hoverYieldsToNavigation = ViewPlugin.fromClass(
  class {
    private off: () => void;
    constructor(view: EditorView) {
      this.off = onNavigationModifier((held) => {
        if (!held || !hasHoverTooltips(view.state)) return;
        if (pointerTarget()?.closest?.(".cm-tooltip")) return;
        view.dispatch({ effects: closeHoverTooltips });
      });
    }
    destroy() {
      this.off();
    }
  },
);

export function hoverExtension(): Extension {
  return [
    hoverTooltip(hoverSource, { hoverTime: Math.max(100, editorPrefs().codeEditing.quickDocDelay) }),
    hoverYieldsToNavigation,
  ];
}

/** The documentation popup has the keyboard (F1 pressed twice, or clicked into). */
function docPopupFocused(): boolean {
  return !!(document.activeElement as HTMLElement | null)?.closest?.("[data-lsp-doc]");
}

/** Lazily resolved declaration of the element at `pos` (Edit Source). */
function definitionOf(doc: number, pos: Pos): () => Promise<Location | null> {
  let found: Promise<Location | null> | null = null;
  return () =>
    (found ??= lspRequest(() => commands.lspGoto(doc, pos, "definition")).then(
      (locs) => locs[0] ?? null,
      () => null,
    ));
}

function showDoc(view: EditorView, entry: DocEntry, at: number) {
  if (docWindowVisible()) {
    showInDocWindow(entry, view.themeClasses);
    return;
  }
  openPopup({
    kind: "doc",
    anchor: caretAnchor(view, at),
    entries: [entry],
    index: 0,
    themeClasses: view.themeClasses,
  });
}

export function showPhpConstructDocumentation(view: EditorView, pos: number): boolean {
  const construct = phpConstructAt(view.state, pos, docOf(view)?.language ?? null);
  if (!construct) return false;
  showDoc(view, { markup: { kind: "markdown", value: construct.markdown }, language: "PHP" }, construct.from);
  return true;
}

/**
 * F1: documentation for the symbol at the caret in a popup (or the
 * Documentation tool window while it is open); in an open lookup, for its
 * selected item. Again on an open popup: focuses it; once more: moves it to
 * the tool window.
 */
export async function quickDocumentation(view: EditorView) {
  if (useLspPopup.getState().popup?.kind === "doc") {
    if (docPopupFocused()) moveDocPopupToWindow();
    else focusPopup();
    return;
  }
  const pos = view.state.selection.main.head;
  const lookup = showLookupDocs(view);
  if (lookup === "shown") return;
  if (lookup === "showing") {
    const doc = await selectedLookupDoc(view).catch(() => null);
    if (!doc) showHint(view, "No documentation found");
    else showDoc(view, { markup: doc.markup, language: doc.language }, pos);
    return;
  }
  try {
    const hover = await requestHover(view, pos);
    if (!hover) {
      showHint(view, "No documentation found");
      return;
    }
    const ctx = docOf(view);
    showDoc(
      view,
      {
        markup: hover.contents,
        language: ctx?.uiMode ?? null,
        source:
          ctx && !phpConstructAt(view.state, pos, ctx.language)
            ? definitionOf(ctx.doc, offsetToPos(view.state.doc, pos))
            : undefined,
      },
      hover.range ? rangeToOffsets(view.state.doc, hover.range).from : pos,
    );
  } catch (e) {
    reportLspError(view, e, true);
  }
}

const DEFINITION_CONTEXT_BEFORE = 1;
const DEFINITION_MAX_LINES = 30;
/** A declaration taller than this is cut (IDEA scrolls; we keep the popup light). */
const DECLARATION_MAX_LINES = 400;
const MAX_TARGETS = 20;

/** Line span to show for a definition: its whole declaration when the syntax tree knows it. */
export function definitionSpan(
  loc: Location,
  lineCount: number,
  declaration: Range | null,
): { first: number; last: number } {
  const start = loc.range.start.line;
  if (declaration && declaration.start.line <= start && start <= declaration.end.line) {
    const first = Math.max(0, declaration.start.line);
    return { first, last: Math.min(lineCount - 1, declaration.end.line, first + DECLARATION_MAX_LINES - 1) };
  }
  const first = Math.max(0, start - DEFINITION_CONTEXT_BEFORE);
  const spanEnd = Math.max(loc.range.end.line, start + 12);
  return { first, last: Math.min(lineCount - 1, Math.min(spanEnd, first + DEFINITION_MAX_LINES - 1)) };
}

async function declarationRange(loc: Location): Promise<Range | null> {
  try {
    return await withDocument(
      loc.path,
      async (doc) => (await structure.structuralRanges(doc, loc.range.start)).declaration?.range ?? null,
    );
  } catch {
    return null;
  }
}

async function definitionTarget(loc: Location, fallbackLanguage: string | null): Promise<DefinitionTarget | null> {
  const [lines, declaration] = await Promise.all([readFileLines(loc.path), declarationRange(loc)]);
  if (!lines) return null;
  const { first, last } = definitionSpan(loc, lines.length, declaration);
  const name = identifierAt(lines[loc.range.start.line] ?? "", loc.range.start.col) ?? basename(loc.path);
  return {
    location: loc,
    name,
    firstLine: first,
    text: lines.slice(first, last + 1).join("\n"),
    language: languageForPath(loc.path) ?? fallbackLanguage,
  };
}

/**
 * ⌥Space: the definition's source in a popup, without leaving the editor; ← / → switch between several.
 * View › Quick Type Definition: the same for the symbol's type (`typeDefinition`).
 */
export async function quickDefinition(view: EditorView, kind: "definition" | "typeDefinition" = "definition") {
  const doc = docOf(view);
  if (!doc) return;
  const pos = view.state.selection.main.head;
  if (kind === "definition" && showPhpConstructDocumentation(view, pos)) return;
  try {
    const found = await lspRequest(() => commands.lspGoto(doc.doc, offsetToPos(view.state.doc, pos), kind));
    const seen = new Set<string>();
    const locations = found.filter((l) => {
      const key = `${l.path}:${l.range.start.line}:${l.range.start.col}`;
      return !seen.has(key) && !!seen.add(key);
    });
    if (!locations.length) {
      showHint(view, kind === "typeDefinition" ? "No type definition found" : "No definition found");
      return;
    }
    const targets = (
      await Promise.all(locations.slice(0, MAX_TARGETS).map((l) => definitionTarget(l, doc.uiMode)))
    ).filter((t): t is DefinitionTarget => !!t);
    if (!targets.length) {
      showHint(view, "Cannot read the definition's file");
      return;
    }
    openPopup({
      kind: "definition",
      anchor: caretAnchor(view, pos),
      targets,
      index: 0,
      themeClasses: view.themeClasses,
    });
  } catch (e) {
    reportLspError(view, e, true);
  }
}
