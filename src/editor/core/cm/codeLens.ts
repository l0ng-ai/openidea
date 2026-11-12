/**
 * Renders `codeLenses` (editor/api) as one small hint row above the target
 * line, indented like the line (IDEA "3 usages   Run test" inlays), and those
 * whose kind is set to "right" (`codeLensPositions`) after the end of that line.
 */
import { EditorState, Facet, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";
import { codeLenses, type CodeLens } from "@/editor/api";
import { guideVars, rainbowGuides } from "./indentGuides";
import { LINE_INSET } from "./lineInset";

/**
 * Where code lenses of each kind (`CodeLens.kind`) go: a row above the declaration (IDEA's default, also for
 * kinds not listed) or after the end of its line.
 */
export const codeLensPositions = Facet.define<
  Readonly<Record<string, "top" | "right">>,
  Readonly<Record<string, "top" | "right">>
>({ combine: (v) => Object.assign({}, ...v) });

/** Groups lenses by line start, ordered by line then `order`. Exported for tests. */
export function groupLenses(
  state: EditorState,
  lenses: readonly CodeLens[],
): Array<{ lineFrom: number; lenses: CodeLens[] }> {
  const byLine = new Map<number, CodeLens[]>();
  const len = state.doc.length;
  for (const l of lenses) {
    if (!(l.pos >= 0 && l.pos <= len)) continue;
    const from = declarationStart(state, state.doc.lineAt(l.pos).number);
    const list = byLine.get(from);
    if (list) list.push(l);
    else byLine.set(from, [l]);
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([lineFrom, list]) => ({
      lineFrom,
      lenses: list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title)),
    }));
}

/** Attribute / annotation / decorator / doc comment lines that belong to the declaration below. */
const PREFIX_LINE = /^\s*(#!?\[|@[\w.]|\/\/\/|\/\/!|\/\*\*|\*(?!\w)|\*\/)/;

/**
 * Line start where a declaration's lens goes: above its attributes,
 * annotations and doc comments (`#[test]`, `@Test`, `/// docs`), like IDEA.
 */
export function declarationStart(state: EditorState, lineNumber: number): number {
  let n = lineNumber;
  for (let i = 0; i < 50 && n > 1; i++) {
    const prev = state.doc.line(n - 1);
    if (!PREFIX_LINE.test(prev.text)) break;
    n--;
  }
  return state.doc.line(n).from;
}

/** Visual indentation (columns) of a line's leading whitespace. */
export function indentColumns(text: string, tabSize: number): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += tabSize - (col % tabSize);
    else break;
  }
  return col;
}

const ICONS: Record<string, string> = {
  run: "M4 3l9 5-9 5z",
  user: "M8 2a3 3 0 110 6 3 3 0 010-6zM2.5 14c0-3 2.5-5 5.5-5s5.5 2 5.5 5z",
  debug: "M8 2a3 3 0 013 3v1h1v2h-1v1h1v2h-1a3 3 0 01-6 0H4V9h1V8H4V6h1V5a3 3 0 013-3z",
};

class LensWidget extends WidgetType {
  constructor(
    readonly lenses: CodeLens[],
    readonly indent: number,
    readonly indentUnit: number,
    readonly rainbow: boolean,
    /** After the end of the line instead of a row above it. */
    readonly inline = false,
  ) {
    super();
  }

  private get key(): string {
    return (
      (this.inline ? "inline\u0000" : "") +
      this.indent +
      "\u0000" +
      this.indentUnit +
      "\u0000" +
      (this.rainbow ? 1 : 0) +
      "\u0000" +
      this.lenses.map((l) => `${l.icon ?? ""}|${l.title}|${l.tooltip ?? ""}|${l.run ? 1 : 0}`).join("\u0001")
    );
  }

  override eq(other: LensWidget): boolean {
    return this.key === other.key && this.lenses.every((l, i) => l.run === other.lenses[i]?.run);
  }

  override toDOM(view: EditorView): HTMLElement {
    // The inline one shares no class with the row, so none of the row's block styles reach into the line.
    const dom = document.createElement(this.inline ? "span" : "div");
    dom.className = this.inline ? "cm-openidea-lensInline" : "cm-openidea-lens";
    this.fill(dom, view);
    return dom;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.fill(dom, view);
    return true;
  }

  private fill(dom: HTMLElement, view: EditorView) {
    dom.textContent = "";
    // The guides of the annotated line continue through this row while indent guides are on.
    const guides = this.inline
      ? null
      : guideVars(Math.floor(this.indent / this.indentUnit), this.indentUnit, this.rainbow);
    if (!this.inline) dom.style.paddingLeft = `${Math.round(this.indent * view.defaultCharacterWidth) + LINE_INSET}px`;
    if (guides) {
      dom.style.setProperty("--openidea-guide-images", guides.images);
      dom.style.setProperty("--openidea-guide-positions", guides.positions);
    } else {
      dom.style.removeProperty("--openidea-guide-images");
      dom.style.removeProperty("--openidea-guide-positions");
    }
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Code lens");
    for (const lens of this.lenses) {
      const el = document.createElement(lens.run ? "button" : "span");
      el.className = lens.run ? "cm-openidea-lensItem cm-openidea-lensAction" : "cm-openidea-lensItem";
      if (lens.tooltip) el.title = lens.tooltip;
      if (lens.icon && ICONS[lens.icon]) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("width", "10");
        svg.setAttribute("height", "10");
        svg.setAttribute("aria-hidden", "true");
        svg.classList.add(`cm-openidea-lensIcon-${lens.icon}`);
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", ICONS[lens.icon]!);
        path.setAttribute("fill", "currentColor");
        svg.appendChild(path);
        el.appendChild(svg);
      }
      el.appendChild(document.createTextNode(lens.title));
      if (lens.run) {
        const button = el as HTMLButtonElement;
        button.type = "button";
        button.tabIndex = -1;
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          lens.run?.(view, e);
        });
      }
      dom.appendChild(el);
    }
  }

  override get estimatedHeight(): number {
    return this.inline ? -1 : 16;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const lenses = state.facet(codeLenses);
  if (!lenses.length) return Decoration.none;
  const positions = state.facet(codeLensPositions);
  const right = (l: CodeLens) => !!l.kind && positions[l.kind] === "right";
  const builder = new RangeSetBuilder<Decoration>();
  for (const group of groupLenses(state, lenses)) {
    const line = state.doc.lineAt(group.lineFrom);
    const indent = indentColumns(line.text, state.tabSize);
    const unit = Math.max(1, getIndentUnit(state));
    const rainbow = state.facet(rainbowGuides);
    const above = group.lenses.filter((l) => !right(l));
    const after = group.lenses.filter(right);
    if (above.length)
      builder.add(
        line.from,
        line.from,
        Decoration.widget({ widget: new LensWidget(above, indent, unit, rainbow), block: true, side: -1 }),
      );
    if (after.length)
      builder.add(
        line.to,
        line.to,
        Decoration.widget({ widget: new LensWidget(after, indent, unit, rainbow, true), side: 1 }),
      );
  }
  return builder.finish();
}

const lensTheme = EditorView.theme({
  ".cm-openidea-lens": {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    height: "16px",
    color: "var(--fg-muted)",
    WebkitUserSelect: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  // "right": after the line's text, on its baseline, with IDEA's spacing.
  ".cm-openidea-lensInline": {
    display: "inline-flex",
    alignItems: "baseline",
    gap: "12px",
    marginLeft: "12px",
    color: "var(--fg-muted)",
    WebkitUserSelect: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  ".cm-openidea-lensItem": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "0",
    border: "none",
    background: "none",
    font: "inherit",
    color: "inherit",
    // The items take the UI font; the row keeps the editor's, so its `ch`-based indent guides line up with the code.
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-tiny)",
  },
  ".cm-openidea-lensAction": { cursor: "pointer" },
  ".cm-openidea-lensAction:hover": { color: "var(--accent)", textDecoration: "underline" },
  ".cm-openidea-lensIcon-run": { color: "var(--success)" },
});

/** Base extension (always installed): no cost until a provider contributes lenses. */
export const codeLensExtension: Extension = [
  EditorView.decorations.compute([codeLenses, rainbowGuides, codeLensPositions], buildDecorations),
  lensTheme,
];
