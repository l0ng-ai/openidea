/**
 * Renders `codeLenses` (editor/api) as one small hint row above the target
 * line, indented like the line (IDEA "3 usages | Run test" inlays).
 */
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { getIndentUnit } from "@codemirror/language";
import { codeLenses, type CodeLens } from "@/editor/api";
import { guideVars, rainbowGuides } from "./indentGuides";

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
  ) {
    super();
  }

  private get key(): string {
    return (
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
    const dom = document.createElement("div");
    dom.className = "cm-openidea-lens";
    this.fill(dom, view);
    return dom;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    this.fill(dom, view);
    return true;
  }

  private fill(dom: HTMLElement, view: EditorView) {
    dom.textContent = "";
    dom.style.paddingLeft = `${Math.round(this.indent * view.defaultCharacterWidth) + 6}px`;
    // The guides of the annotated line continue through this row while indent guides are on.
    const guides = guideVars(Math.floor(this.indent / this.indentUnit), this.indentUnit, this.rainbow);
    if (guides) {
      dom.style.setProperty("--openidea-guide-images", guides.images);
      dom.style.setProperty("--openidea-guide-positions", guides.positions);
    } else {
      dom.style.removeProperty("--openidea-guide-images");
      dom.style.removeProperty("--openidea-guide-positions");
    }
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Code lens");
    this.lenses.forEach((lens, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "cm-openidea-lensSep";
        sep.textContent = "|";
        sep.setAttribute("aria-hidden", "true");
        dom.appendChild(sep);
      }
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
    });
  }

  override get estimatedHeight(): number {
    return 16;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const lenses = state.facet(codeLenses);
  if (!lenses.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const group of groupLenses(state, lenses)) {
    const line = state.doc.lineAt(group.lineFrom);
    const widget = new LensWidget(
      group.lenses,
      indentColumns(line.text, state.tabSize),
      Math.max(1, getIndentUnit(state)),
      state.facet(rainbowGuides),
    );
    builder.add(line.from, line.from, Decoration.widget({ widget, block: true, side: -1 }));
  }
  return builder.finish();
}

const lensTheme = EditorView.theme({
  ".cm-openidea-lens": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "16px",
    color: "var(--fg-muted)",
    WebkitUserSelect: "none",
    userSelect: "none",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  ".cm-openidea-lensItem": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    padding: "0",
    border: "none",
    background: "none",
    font: "inherit",
    color: "inherit",
  },
  // The row keeps the editor font so its `ch`-based indent guides line up with the code.
  ".cm-openidea-lensItem, .cm-openidea-lensSep": {
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-tiny)",
  },
  ".cm-openidea-lensAction": { cursor: "pointer" },
  ".cm-openidea-lensAction:hover": { color: "var(--accent)", textDecoration: "underline" },
  ".cm-openidea-lensSep": { color: "var(--fg-faint)" },
  ".cm-openidea-lensIcon-run": { color: "var(--success)" },
});

/** Base extension (always installed): no cost until a provider contributes lenses. */
export const codeLensExtension: Extension = [
  EditorView.decorations.compute([codeLenses, rainbowGuides], buildDecorations),
  lensTheme,
];
