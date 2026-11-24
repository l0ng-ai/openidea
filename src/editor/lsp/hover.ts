/**
 * Hover tooltip (500ms): diagnostics under the pointer + quick documentation,
 * plus the explicit actions code.quickDocumentation (F1, sticky popup with
 * history, `docs.ts`) and code.quickDefinition (⌥Space, definition source popup).
 */
import { EditorSelection } from "@codemirror/state";
import {
  closeHoverTooltips,
  hasHoverTooltips,
  hoverTooltip,
  repositionTooltips,
  ViewPlugin,
  type EditorView,
  type TooltipView,
} from "@codemirror/view";
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
import { tx } from "@/platform/i18n";
import { shortcutLabel } from "@/platform/keymap";
import { diagnosticsAt, type PlacedDiagnostic, type EditorDiagnostic } from "./diagnostics";
import { isEmptyMarkup, languageForPath } from "./markdown";
import { selectableText } from "@/ui/selectableText";
import { docOf, lspRequest, reportLspError } from "./lsp";
import { requestNavigation } from "./configurationNavigation";
import { offsetToPos, rangeToOffsets } from "./positions";
import { showHint } from "./hint";
import { caretAnchor, focusPopup, openPopup, useLspPopup, type DefinitionTarget, type DocEntry } from "./popupStore";
import { selectedLookupDoc, showLookupDocs } from "./completion";
import { readFileLines, targetLabel, withDocument } from "./files";
import { docWindowVisible, hoverDoc, moveDocPopupToWindow, showInDocWindow } from "./docs";
import { mountHoverDoc } from "./DocView";
import { structure } from "@/editor/structure";
import { basename } from "@/platform/project";
import { iconNode } from "@/ui/iconNode";
import { applyCodeAction, quickFixesAt } from "./intentions";
import { editorPrefs } from "@/platform/editorSettings";
import { CONTRIBUTED_HOVER, contributedAtAll, type ContributedHover } from "@/editor/api";
import { navigationModifierHeld, onNavigationModifier, pointerTarget } from "@/platform/navigationModifier";
import { languageSemantics } from "./semantic";
import { tooltipBounds } from "@/editor/core/cm/setup";

let hoverRequest: RequestId | null = null;

/** Documentation of a language construct (PHP's `empty`) at `pos`, via the language's registration. */
function constructAt(state: EditorView["state"], pos: number, language: string | null | undefined) {
  return languageSemantics(language)?.constructAt?.(state, pos) ?? null;
}

export async function requestHover(view: EditorView, pos: number): Promise<Hover | null> {
  for (const own of contributedAtAll<ContributedHover>(view.state, CONTRIBUTED_HOVER, pos)) {
    const h = own(view.state, pos);
    if (!h) continue;
    const range = { start: offsetToPos(view.state.doc, h.from), end: offsetToPos(view.state.doc, h.to) };
    return { contents: { kind: "markdown", value: h.markdown }, range };
  }
  const doc = docOf(view);
  if (!doc) return null;
  const construct = constructAt(view.state, pos, doc.language);
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

function diagnosticAction(label: string, shortcut: string | undefined, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-lsp-link-button";
  const text = document.createElement("span");
  text.className = "cm-lsp-diag-action-label";
  text.textContent = label;
  button.appendChild(text);
  if (shortcut) {
    const keys = document.createElement("span");
    keys.className = "cm-lsp-diag-shortcut";
    keys.textContent = shortcut;
    keys.setAttribute("aria-hidden", "true");
    button.appendChild(keys);
  }
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", run);
  return button;
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
    if (d.source) {
      const src = document.createElement("span");
      src.className = "cm-lsp-diag-source";
      src.textContent = d.source;
      row.appendChild(src);
    }
    const actions = document.createElement("div");
    actions.className = "cm-lsp-diag-actions";
    const more = diagnosticAction(tx("More actions…"), shortcutLabel("code.showIntentions"), () => {
      view.dispatch({ selection: EditorSelection.cursor(from) });
      view.focus();
      void executeAction("code.showIntentions");
    });
    actions.appendChild(more);
    if (d.severity !== "hint") offerQuickFix(view, more, from, to, d);
    row.appendChild(actions);
    box.appendChild(row);
  }
  return box;
}

/** IDEA's hover link to the problem's preferred quick fix, shown once the server named one. */
function offerQuickFix(view: EditorView, before: HTMLElement, from: number, to: number, diagnostic: EditorDiagnostic) {
  const doc = view.state.doc;
  void quickFixesAt(view, from, to, diagnostic.problem)
    .then(([action]) => {
      if (!action || view.state.doc !== doc || !before.isConnected) return;
      const link = diagnosticAction(action.title, shortcutLabel("code.applyQuickFix"), () => {
        view.dispatch({ effects: closeHoverTooltips });
        view.focus();
        void applyCodeAction(view, action);
      });
      before.before(link);
    })
    .catch(() => {});
}

/**
 * Whether the plain hover (problems + quick documentation) stays out: while
 * ⌘/Ctrl is held the ⌘-hover link and its brief info (`navigation.ts`) own the
 * pointer, as in IDEA. Inlay hints and folded code have their own tooltips.
 */
export function hoverYields(): boolean {
  return navigationModifierHeld() || !!pointerTarget()?.closest?.(".cm-lsp-inlay, .cm-foldPlaceholder");
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
  const entry = hover && docEntry(view, pos, hover);
  return {
    pos: from,
    end: to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = `cm-lsp-hover ${selectableText}`;
      const tooltip: TooltipView = { dom };
      if (diags.length) {
        dom.appendChild(renderDiagnostics(view, diags));
        const fit = ({ left, right }: { left: number; right: number }) => {
          const width = `${Math.max(0, Math.floor(right - left) - 2)}px`;
          if (dom.style.getPropertyValue("--cm-diagnostic-hover-width") === width) return false;
          dom.style.setProperty("--cm-diagnostic-hover-width", width);
          return true;
        };
        tooltip.mount = () => void fit(tooltipBounds(view));
        tooltip.positioned = (space) => {
          if (fit(space)) repositionTooltips(view);
        };
      }
      if (!entry) return tooltip;
      // The same documentation view as F1's popup: links open in place, ← / →, Edit Source.
      dom.classList.add("cm-lsp-hover-doc");
      const doc = hoverDoc(entry, () => view.dispatch({ effects: closeHoverTooltips }));
      tooltip.destroy = mountHoverDoc(dom.appendChild(document.createElement("div")), doc);
      return tooltip;
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
    hoverTooltip(hoverSource, {
      hoverTime: Math.max(100, editorPrefs().codeEditing.quickDocDelay),
      hideOnChange: true,
    }),
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

/** The documentation `hover` shows for `pos`, with its declaration for Edit Source. */
function docEntry(view: EditorView, pos: number, hover: Hover): DocEntry {
  const ctx = docOf(view);
  return {
    markup: hover.contents,
    language: ctx?.uiMode ?? null,
    file: ctx?.path,
    source:
      ctx && !constructAt(view.state, pos, ctx.language)
        ? definitionOf(ctx.doc, offsetToPos(view.state.doc, pos))
        : undefined,
  };
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
  const construct = constructAt(view.state, pos, docOf(view)?.language);
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
    showDoc(view, docEntry(view, pos, hover), hover.range ? rangeToOffsets(view.state.doc, hover.range).from : pos);
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
  const name = targetLabel(lines[loc.range.start.line] ?? "", loc.range.start.col) ?? basename(loc.path);
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
  const source = view.state.doc;
  const stale = () => !view.dom.isConnected || view.state.doc !== source || docOf(view) !== doc;
  if (kind === "definition" && showPhpConstructDocumentation(view, pos)) return;
  try {
    const found = await requestNavigation(view, pos, kind);
    if (stale()) return;
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
    if (stale()) return;
    if (!targets.length) {
      showHint(view, "Cannot read the definition's file");
      return;
    }
    const { fontFamily, fontSize, fontWeight, lineHeight, tabSize } = getComputedStyle(view.contentDOM);
    openPopup({
      kind: "definition",
      anchor: caretAnchor(view, pos),
      targets,
      index: 0,
      themeClasses: view.themeClasses,
      codeStyle: { fontFamily, fontSize, fontWeight, lineHeight, tabSize },
    });
  } catch (e) {
    if (!stale()) reportLspError(view, e, true);
  }
}
