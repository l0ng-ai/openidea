/**
 * The base extension set of every text editor, with compartments for the
 * parts that change at runtime (language, settings, contributions).
 */
import { Compartment, EditorState, Prec, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  dropCursor,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  tooltips,
} from "@codemirror/view";
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
  type MatchResult,
} from "@codemirror/language";
import { history, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches } from "@codemirror/search";
import type { EditorConfigProps } from "@/bindings";
import type { EditorSettings } from "@/platform/ipc";
import { editorPrefs, lineCommentStyleFor, type EditorExtras } from "@/platform/editorSettings";
import { BUNDLED_MONO_FAMILY, monoFontFamily } from "@/platform/fonts";
import { editorContributions, type EditorDocContext } from "@/editor/api";
import { distractionFreeWidth, isDistractionFree } from "@/workbench/distractionFree";
import { openideaHighlightStyle } from "./highlight";
import { openideaTheme } from "./theme";
import { caretRowHighlight } from "./caretRow";
import { changeLane, overviewLane } from "./lanes";
import { foldingExtension } from "./folding";
import { syntaxHighlightField } from "./syntaxHighlight";
import { indentGuides } from "./indentGuides";
import { rainbowBrackets } from "./rainbowBrackets";
import { stickyMaxLines, stickyScroll } from "./stickyScroll";
import { findExtension } from "./find";
import { codeLensExtension } from "./codeLens";
import { caretExtension, fontZoom, methodLinesField, prefsExtension, softWrapActive } from "./prefs";
import { commentTokens } from "./languages";
import { multiCaretMouse } from "./multiCaret";
import { columnModeExtension } from "./columnMode";
import { visibleGoalColumns } from "./verticalMotion";
import { tabKeymap } from "./smartKeys";
import { editorBaseKeymap } from "./baseKeymap";
import { occurrenceSearch } from "./editing";
import { gutterLineDrag } from "./gutterDrag";
import { overwriteField } from "./overwrite";
import { clipboardHistoryExtension } from "../clipboardHistory";
import type { LanguageInfo } from "../backend";
import { tx } from "@/platform/i18n";

export const compartments = {
  language: new Compartment(),
  comments: new Compartment(),
  indent: new Compartment(),
  readOnly: new Compartment(),
  wrap: new Compartment(),
  sticky: new Compartment(),
  font: new Compartment(),
  heavy: new Compartment(),
  contributions: new Compartment(),
  lineNumbers: new Compartment(),
  folding: new Compartment(),
  caret: new Compartment(),
  prefs: new Compartment(),
  distractionFree: new Compartment(),
};

/** Editor-group settings of an `editor` settings object (validated, with defaults). */
export function prefsOf(settings: EditorSettings | undefined): EditorExtras {
  return editorPrefs({ editor: settings });
}

/** Documents above this size (UTF-16 units) skip per-line decorations. */
export const HEAVY_LIMIT = 8_000_000;

export interface EffectiveIndent {
  tabSize: number;
  insertSpaces: boolean;
  /** Indent width when it differs from the tab size (Code Style › Indent). */
  indentSize?: number;
}

/** Indentation found in a file's text (Detect and use existing file indents for editing). */
export function detectIndent(text: string): { insertSpaces: boolean; size?: number } | null {
  let tabs = 0;
  let spaces = 0;
  const deltas = new Map<number, number>();
  let prev = 0;
  let n = 0;
  for (const line of text.split("\n", 4000)) {
    if (!line.trim()) continue;
    n++;
    const m = /^[ \t]*/.exec(line)![0];
    if (m.startsWith("\t")) tabs++;
    else if (m.length >= 2) spaces++;
    if (!m.includes("\t")) {
      const d = m.length - prev;
      if (d >= 2 && d <= 8) deltas.set(d, (deltas.get(d) ?? 0) + 1);
      prev = m.length;
    }
  }
  if (n < 2 || (tabs === 0 && spaces === 0)) return null;
  if (tabs > spaces) return { insertSpaces: false };
  let best: number | undefined;
  for (const [d, c] of deltas)
    if (best === undefined || c > deltas.get(best)! || (c === deltas.get(best)! && d < best)) best = d;
  return { insertSpaces: true, size: best };
}

/**
 * Indentation: `.editorconfig` first (when EditorConfig support is on), then the
 * file's detected indents, then Code Style (per-language override, language
 * definition, defaults).
 */
export function effectiveIndent(
  settings: EditorSettings | undefined,
  info: LanguageInfo | undefined,
  editorconfig?: EditorConfigProps | null,
  detected?: { insertSpaces: boolean; size?: number } | null,
): EffectiveIndent {
  const prefs = prefsOf(settings);
  const lang = info ? prefs.codeStyle.languages[info.id] : undefined;
  const fallback = info?.indent
    ? { tabSize: info.indent.tabSize, insertSpaces: info.indent.insertSpaces }
    : { tabSize: settings?.tabSize ?? 4, insertSpaces: settings?.insertSpaces ?? true };
  let base: EffectiveIndent = {
    tabSize: lang?.tabSize ?? fallback.tabSize,
    insertSpaces: lang?.useTab !== undefined ? !lang.useTab : fallback.insertSpaces,
  };
  const indentSize = lang?.indent;
  if (indentSize !== undefined && indentSize !== base.tabSize) base.indentSize = indentSize;
  if (detected && prefs.codeStyle.detectIndents) {
    base = detected.insertSpaces
      ? { tabSize: detected.size ?? base.indentSize ?? base.tabSize, insertSpaces: true }
      : { tabSize: base.tabSize, insertSpaces: false };
  }
  if (!editorconfig || !prefs.codeStyle.editorconfig) return base;
  return {
    tabSize: editorconfig.indentSize ?? editorconfig.tabWidth ?? base.tabSize,
    insertSpaces: editorconfig.indentStyle ? editorconfig.indentStyle === "space" : base.insertSpaces,
  };
}

/** Hard wrap column of a language (Code Style override, else General). */
export function hardWrapAt(settings: EditorSettings | undefined, info: LanguageInfo | undefined): number {
  const style = prefsOf(settings).codeStyle;
  return (info && style.languages[info.id]?.hardWrapAt) || style.hardWrapAt;
}

export function indentExtension(indent: EffectiveIndent): Extension {
  return [
    EditorState.tabSize.of(indent.tabSize),
    indentUnit.of(indent.insertSpaces ? " ".repeat(Math.max(1, indent.indentSize ?? indent.tabSize)) : "\t"),
  ];
}

export function fontExtension(settings: EditorSettings | undefined): Extension {
  const vars: string[] = [];
  const prefs = prefsOf(settings);
  const family = settings?.fontFamily;
  const fallback = prefs.fallbackFont.trim();
  if ((family && family !== BUNDLED_MONO_FAMILY) || fallback) {
    vars.push(`--openidea-editor-font: ${monoFontFamily(family, fallback, "var(--font-mono)")}`);
  }
  if (settings?.fontSize)
    vars.push(
      `--openidea-editor-font-size: ${settings.fontSize}px`,
      `--openidea-editor-base-size: ${settings.fontSize}px`,
    );
  if (settings?.lineHeight)
    vars.push(
      `--openidea-editor-line-height: ${settings.lineHeight}px`,
      `--openidea-editor-base-line: ${settings.lineHeight}px`,
    );
  const attrs: Record<string, string> = {};
  if (vars.length) attrs.style = vars.join("; ");
  if (prefs.ligatures) attrs.class = "cm-openidea-ligatures";
  return Object.keys(attrs).length ? EditorView.editorAttributes.of(attrs) : [];
}

export function readOnlyExtension(readOnly: boolean): Extension {
  return readOnly ? [EditorState.readOnly.of(true)] : [];
}

/** Soft wraps per settings (file patterns), unless toggled for the file (`override`). */
export function wrapExtension(
  settings: EditorSettings | undefined,
  path: string,
  override?: boolean | null,
): Extension {
  return (override ?? softWrapActive(settings?.softWrap, prefsOf(settings), path)) ? EditorView.lineWrapping : [];
}

export function stickyExtension(settings: EditorSettings | undefined): Extension {
  return settings?.stickyScroll === false || isDistractionFree()
    ? []
    : [stickyScroll, stickyMaxLines.of(prefsOf(settings).codeEditing.stickyLinesMax)];
}

const matchingBracket = Decoration.mark({ class: "cm-matchingBracket" });
const matchingTag = Decoration.mark({ class: "cm-matchingBracket cm-matchingTag" });
const nonmatchingBracket = Decoration.mark({ class: "cm-nonmatchingBracket" });

/** Like the default, but matched tag names (HTML / XML / JSX) get their own mark, as IDEA's MATCHED_TAG_NAME. */
function renderMatch(match: MatchResult, state: EditorState): readonly Range<Decoration>[] {
  const mark = (from: number, to: number) =>
    !match.matched ? nonmatchingBracket : /^[()[\]{}]$/.test(state.sliceDoc(from, to)) ? matchingBracket : matchingTag;
  const out = [mark(match.start.from, match.start.to).range(match.start.from, match.start.to)];
  if (match.end) out.push(mark(match.end.from, match.end.to).range(match.end.from, match.end.to));
  return out;
}

export function heavyExtension(docLength: number, settings?: EditorSettings): Extension {
  if (docLength > HEAVY_LIMIT) return [];
  const prefs = prefsOf(settings);
  return [
    prefs.codeEditing.highlightBraces ? bracketMatching({ renderMatch }) : [],
    prefs.appearance.indentGuides ? indentGuides : [],
    prefs.rainbowBrackets ? rainbowBrackets() : [],
    prefs.codeEditing.highlightSelection ? highlightSelectionMatches({ minSelectionLength: 2, maxMatches: 500 }) : [],
  ];
}

export function lineNumbersExtension(settings: EditorSettings | undefined): Extension {
  return prefsOf(settings).appearance.lineNumbers && !isDistractionFree() ? lineNumbers() : [];
}

/**
 * Distraction Free Mode: no gutter, text column centred at the configured
 * width (see `cm-openidea-distractionFree` in theme.ts).
 */
export function distractionFreeExtension(
  settings: EditorSettings | undefined,
  active = isDistractionFree(),
): Extension {
  if (!active) return [];
  const columns = distractionFreeWidth(prefsOf(settings).appearance.distractionFreeWidth);
  return EditorView.editorAttributes.of({
    class: "cm-openidea-distractionFree",
    style: `--openidea-df-columns: ${columns}`,
  });
}

export function foldingFor(settings: EditorSettings | undefined): Extension {
  return foldingExtension(prefsOf(settings).folding.showOutline);
}

export function caretFor(settings: EditorSettings | undefined): Extension {
  return caretExtension(prefsOf(settings));
}

export function prefsFor(o: {
  settings: EditorSettings | undefined;
  path: string;
  info: LanguageInfo | undefined;
  readOnly: boolean;
  wrapOverride?: boolean | null;
}): Extension {
  return prefsExtension({
    prefs: prefsOf(o.settings),
    path: o.path,
    softWrap: o.settings?.softWrap,
    wrapOverride: o.wrapOverride,
    showWhitespace: o.settings?.showWhitespace,
    hardWrapAt: hardWrapAt(o.settings, o.info),
    readOnly: o.readOnly,
    distractionFree: isDistractionFree(),
    language: o.info?.id,
    commentStyle: lineCommentStyleFor(prefsOf(o.settings), o.info?.id),
  });
}

export function contributionExtensions(ctx: EditorDocContext): Extension {
  const out: Extension[] = [];
  for (const c of editorContributions()) {
    try {
      out.push(c.extensions(ctx));
    } catch (e) {
      console.error(`editor contribution ${c.id} failed`, e);
    }
  }
  return out;
}

export interface SetupOptions {
  ctx: EditorDocContext;
  settings: EditorSettings | undefined;
  info: LanguageInfo | undefined;
  language: LanguageSupport | null;
  docLength: number;
  /** Effective indentation of the document (detected / overridden); computed when absent. */
  indent?: EffectiveIndent;
  /** Soft wraps toggled for this file (View › Active Editor › Soft-Wrap). */
  wrapOverride?: boolean | null;
  /** Extra extensions owned by the slot (update listeners, focus handlers). */
  extra?: Extension;
}

/**
 * Tooltips (hints, docs, completion) stay below the editor's top edge: one
 * above the first lines flips below them instead of hiding under the tabs.
 */
const tooltipSpace = tooltips({
  tooltipSpace: (view) => {
    const top = view.scrollDOM.getBoundingClientRect().top;
    return { top, left: 0, right: window.innerWidth, bottom: window.innerHeight };
  },
});

export function baseExtensions(o: SetupOptions): Extension {
  return [
    tooltipSpace,
    compartments.font.of(fontExtension(o.settings)),
    openideaTheme,
    compartments.lineNumbers.of(lineNumbersExtension(o.settings)),
    // New UI order: numbers | contributed icon gutters | VCS bar | fold chevrons.
    Prec.lowest(changeLane),
    compartments.folding.of(foldingFor(o.settings)),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    compartments.caret.of(caretFor(o.settings)),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    multiCaretMouse,
    columnModeExtension,
    visibleGoalColumns,
    occurrenceSearch,
    overwriteField,
    gutterLineDrag,
    clipboardHistoryExtension,
    indentOnInput(),
    syntaxHighlighting(openideaHighlightStyle),
    syntaxHighlightField,
    closeBrackets(),
    caretRowHighlight,
    fontZoom,
    methodLinesField,
    findExtension(),
    overviewLane,
    codeLensExtension,
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      "aria-label": tx`Editor for ${o.ctx.path}`,
    }),
    tabKeymap,
    keymap.of([...closeBracketsKeymap, ...editorBaseKeymap, indentWithTab]),
    compartments.language.of(o.language ?? []),
    compartments.comments.of(commentTokens(o.info, o.ctx.language)),
    compartments.indent.of(indentExtension(o.indent ?? effectiveIndent(o.settings, o.info))),
    compartments.readOnly.of(readOnlyExtension(o.ctx.readOnly)),
    compartments.wrap.of(wrapExtension(o.settings, o.ctx.path, o.wrapOverride)),
    compartments.sticky.of(stickyExtension(o.settings)),
    compartments.heavy.of(heavyExtension(o.docLength, o.settings)),
    compartments.prefs.of(
      prefsFor({
        settings: o.settings,
        path: o.ctx.path,
        info: o.info,
        readOnly: o.ctx.readOnly,
        wrapOverride: o.wrapOverride,
      }),
    ),
    compartments.contributions.of(contributionExtensions(o.ctx)),
    compartments.distractionFree.of(distractionFreeExtension(o.settings)),
    o.extra ?? [],
  ];
}
