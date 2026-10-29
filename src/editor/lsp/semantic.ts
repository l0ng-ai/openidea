/**
 * Semantic highlighting: `lsp_semantic_tokens` → mark decorations with
 * `cm-sem-*` classes (styled with the --syn-* tokens) layered over the Lezer
 * highlighting. Refreshed after edits (debounced); in between, existing marks
 * are mapped through the changes.
 *
 * Semantic highlighting (Color Scheme › Language Defaults, IDEA's rainbow
 * identifiers): local variables and parameters additionally get
 * `cm-sem-rainbow-<n>`, `n` derived from the name, so one name keeps one
 * colour (`--syn-rainbow-<n>`) throughout the file.
 */
import { Prec, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { commands, type SemanticTokens } from "@/platform/ipc";
import { editorPrefs } from "@/platform/editorSettings";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { featureBackoff, onLspRefresh } from "./availability";

const semanticBackoff = featureBackoff();

const TYPE_CLASS: Record<string, string> = {
  type: "type",
  class: "type",
  enum: "type",
  interface: "type",
  struct: "type",
  typeAlias: "type",
  builtinType: "type",
  selfTypeKeyword: "keyword",
  typeParameter: "typeParameter",
  function: "function",
  method: "function",
  macro: "macro",
  decorator: "annotation",
  // jdtls extensions
  annotation: "annotation",
  annotationMember: "function",
  record: "type",
  recordComponent: "property",
  attribute: "annotation",
  enumMember: "constant",
  property: "property",
  parameter: "parameter",
  variable: "variable",
  namespace: "namespace",
  lifetime: "annotation",
  selfParameter: "self",
  clsParameter: "self",
  selfKeyword: "self",
};

const MODIFIER_CLASS: Record<string, string> = {
  deprecated: "deprecated",
  static: "static",
  mutable: "mutable",
  declaration: "declaration",
  definition: "declaration",
  defaultLibrary: "builtin",
};

/** Number of `--syn-rainbow-<n>` colours (IDEA's five semantic highlighting colours). */
export const RAINBOW_COLORS = 5;

/** Stable 1-based palette index of an identifier (FNV-1a over its UTF-16 units). */
export function rainbowIndex(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % RAINBOW_COLORS) + 1;
}

/** Locals and parameters only: no fields, statics, constants, library or `self` names. */
const RAINBOW_TYPES = new Set(["variable", "parameter"]);
const NOT_LOCAL = new Set(["static", "constant", "defaultLibrary", "global", "classScope", "fileScope"]);

export interface SemanticRange {
  from: number;
  to: number;
  className: string;
}

/** Decodes absolute `[line, col, len, type, modifiers]` quintuples into styled ranges. */
export function semanticRanges(doc: Text, tokens: SemanticTokens, rainbow = false, language?: string): SemanticRange[] {
  const out: SemanticRange[] = [];
  const { data, tokenTypes, tokenModifiers } = tokens;
  // Servers with a `local` modifier (TypeScript) tell module-level variables apart.
  const marksLocals = tokenModifiers.includes("local");
  for (let i = 0; i + 4 < data.length; i += 5) {
    const line = data[i]!,
      col = data[i + 1]!,
      len = data[i + 2]!,
      typeIdx = data[i + 3]!,
      mods = data[i + 4]!;
    if (line >= doc.lines || len <= 0) continue;
    const type = tokenTypes[typeIdx] ?? "";
    const names: string[] = [];
    for (let b = 0; b < tokenModifiers.length; b++) if (mods & (1 << b)) names.push(tokenModifiers[b]!);
    const classes: string[] = [];
    let base = Object.hasOwn(TYPE_CLASS, type) ? TYPE_CLASS[type] : undefined;
    // jdtls marks constructors as a class with a `constructor` modifier; IDEA colours them as methods.
    if (names.includes("constructor")) base = "function";
    const constant =
      names.includes("constant") || (type === "variable" && names.includes("readonly") && names.includes("static"));
    if (constant && (type === "variable" || type === "property")) base = "constant";
    if (base && base !== "variable") classes.push(`cm-sem-${base}`);
    // `hasOwn`: servers send names like `constructor` (jdtls) that `Object.prototype` also has.
    for (const n of names) if (Object.hasOwn(MODIFIER_CLASS, n)) classes.push(`cm-sem-${MODIFIER_CLASS[n]}`);
    if (language === "python" && names.includes("static")) classes.push("cm-sem-python-static");
    const local =
      rainbow &&
      !constant &&
      RAINBOW_TYPES.has(type) &&
      !names.some((n) => NOT_LOCAL.has(n)) &&
      (type === "parameter" || !marksLocals || names.includes("local"));
    if (!classes.length && !local) continue;
    const l = doc.line(line + 1);
    const from = l.from + Math.min(col, l.length);
    const to = Math.min(from + len, l.to);
    if (from >= to) continue;
    if (local) classes.push(`cm-sem-rainbow-${rainbowIndex(doc.sliceString(from, to))}`);
    out.push({ from, to, className: classes.join(" ") });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

const markCache = new Map<string, Decoration>();
const markFor = (cls: string) => {
  let m = markCache.get(cls);
  if (!m) markCache.set(cls, (m = Decoration.mark({ class: cls })));
  return m;
};

const setSemantic = StateEffect.define<DecorationSet>();

const semanticField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setSemantic)) return e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
});

const semanticPlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void this.run(), 600);
    private offReady: () => void;
    private rainbow = editorPrefs().semanticHighlighting;
    /** Last answer, re-decorated without a request when Semantic highlighting is toggled. */
    private last: { doc: Text; tokens: SemanticTokens | null } | null = null;
    private destroyed = false;
    constructor(private view: EditorView) {
      this.refresh();
      this.offReady = onLspRefresh("semanticTokens", () => this.refresh());
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.refresh();
      const rainbow = editorPrefs().semanticHighlighting;
      if (rainbow === this.rainbow) return;
      this.rainbow = rainbow;
      const last = this.last;
      // Settings arrive as a compartment reconfiguration; no dispatching inside an update.
      if (last && last.doc === u.state.doc)
        queueMicrotask(() => {
          if (!this.destroyed && this.view.state.doc === last.doc) this.decorate(last.doc, last.tokens);
        });
      else this.refresh();
    }
    decorate(doc: Text, tokens: SemanticTokens | null) {
      this.last = { doc, tokens };
      const ranges = tokens ? semanticRanges(doc, tokens, this.rainbow, docOf(this.view)?.language) : [];
      this.view.dispatch({
        effects: setSemantic.of(
          Decoration.set(
            ranges.map((r) => markFor(r.className).range(r.from, r.to)),
            true,
          ),
        ),
      });
    }
    async run() {
      const view = this.view;
      const doc = docOf(view);
      if (!doc || semanticBackoff.active(doc.doc) || !view.dom.isConnected) return;
      const state = view.state;
      try {
        const tokens = await lspRequest(() => commands.lspSemanticTokens(doc.doc));
        if (view.state.doc !== state.doc) return this.refresh();
        this.decorate(state.doc, tokens);
      } catch (e) {
        if (isUnavailable(e)) semanticBackoff.mark(doc.doc);
      }
    }
    destroy() {
      this.destroyed = true;
      this.refresh.cancel();
      this.offReady();
    }
  },
);

export function semanticExtension(): Extension {
  // Higher-precedence decoration sources create the *inner* DOM nodes, so this
  // must outrank Lezer's highlighter for semantic colours to win; they only set
  // colour / style, never backgrounds. `Prec.highest`, not `Prec.high`: the
  // highlighter (`treeHighlighter` in @codemirror/language) is itself
  // `Prec.high`, and at equal precedence the later source ends up outside —
  // its inner span then re-set the colour (a field's `variableName` grey hid
  // `cm-sem-property`).
  return [semanticField, semanticPlugin, Prec.highest(EditorView.decorations.from(semanticField))];
}
