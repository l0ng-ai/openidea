/**
 * Color preview gutter: a swatch on each line with a color literal (the first one), as IDEA's
 * color gutter icons. Clicking it in an editable file opens the system color picker; the picked
 * color replaces the literal in its own format (alpha kept, the picker has none).
 */
import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter, type EditorView } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { findColors, formatColor, fromHex6, parseComputed, toHex6, type ColorMatch, type Rgba } from "./colors";
import styles from "./ColorPreview.module.css";

/** Longer lines (minified style sheets) are not scanned. */
const MAX_LINE = 2000;

const names = new Map<string, boolean>();
function isColorName(word: string): boolean {
  let known = names.get(word);
  if (known === undefined) {
    known = typeof CSS !== "undefined" && CSS.supports("color", word);
    names.set(word, known);
  }
  return known;
}

let probe: HTMLElement | null = null;
/** The literal's components, as the browser parses it. */
function rgbaOf(text: string): Rgba | null {
  if (!probe?.isConnected) {
    probe = document.createElement("span");
    probe.hidden = true;
    document.body.append(probe);
  }
  probe.style.color = "";
  probe.style.color = text;
  return probe.style.color ? parseComputed(getComputedStyle(probe).color) : null;
}

class Swatch extends GutterMarker {
  constructor(
    readonly color: ColorMatch,
    readonly editable: boolean,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof Swatch &&
      other.color.text === this.color.text &&
      other.color.from === this.color.from &&
      other.editable === this.editable
    );
  }
  override toDOM() {
    const el = document.createElement("span");
    el.className = this.editable ? `${styles.swatch} ${styles.editable}` : `${styles.swatch}`;
    el.title = this.color.text;
    const fill = document.createElement("span");
    fill.style.background = this.color.text;
    el.append(fill);
    return el;
  }
}

function lineColor(view: EditorView, pos: number, language: string): ColorMatch | null {
  const line = view.state.doc.lineAt(pos);
  if (line.length > MAX_LINE) return null;
  return findColors(line.text, language, isColorName)[0] ?? null;
}

let picker: HTMLInputElement | null = null;

/** Opens the system color picker for `color` at `from`; each pick replaces the literal. */
function pickColor(view: EditorView, from: number, color: ColorMatch, at: { x: number; y: number }) {
  const rgba = rgbaOf(color.text);
  if (!rgba) return;
  picker?.remove();
  const input = document.createElement("input");
  picker = input;
  input.type = "color";
  input.className = `${styles.picker}`;
  input.style.left = `${at.x}px`;
  input.style.top = `${at.y}px`;
  input.value = toHex6(rgba);
  document.body.append(input);
  let current = color.text;
  const apply = () => {
    const next = fromHex6(input.value, rgba[3]);
    // The literal changed meanwhile: leave it alone.
    if (!next || view.state.sliceDoc(from, from + current.length) !== current) return;
    const text = formatColor(next, color);
    if (text === current) return;
    view.dispatch({ changes: { from, to: from + current.length, insert: text }, userEvent: "input.color" });
    current = text;
  };
  input.addEventListener("input", apply);
  input.addEventListener("change", () => {
    apply();
    input.remove();
  });
  try {
    input.showPicker();
  } catch {
    input.click();
  }
}

export function colorPreviewGutter(ctx: EditorDocContext): Extension {
  return gutter({
    class: `${styles.gutter} cm-openidea-gutter-colors`,
    lineMarker: (view, block) => {
      const color = lineColor(view, block.from, ctx.language);
      return color ? new Swatch(color, !view.state.readOnly) : null;
    },
    lineMarkerChange: (update) => update.docChanged || update.startState.readOnly !== update.state.readOnly,
    domEventHandlers: {
      mousedown: (view, block, event) => {
        const e = event as MouseEvent;
        const swatch = e.target instanceof Element ? e.target.closest(`.${styles.swatch}`) : null;
        if (e.button !== 0 || !swatch || view.state.readOnly) return false;
        const line = view.state.doc.lineAt(block.from);
        const color = lineColor(view, block.from, ctx.language);
        if (!color) return false;
        e.preventDefault();
        const rect = swatch.getBoundingClientRect();
        pickColor(view, line.from + color.from, color, { x: rect.left, y: rect.bottom + 2 });
        return true;
      },
    },
  });
}
