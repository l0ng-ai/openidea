/** Swatches for colors a provider (a plugin or a language server) reports, and its picker flow. */
import { GutterMarker, type EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { rangeToOffsets } from "@/editor/api";
import { showHint } from "@/editor/lsp/hint";
import type { Range } from "@/platform/ipc";
import { showContextMenu } from "@/ui";
import { openColorPicker } from "./ColorPicker";
import styles from "./ColorPreview.module.css";

/** Components are 0–1. */
export interface ProviderColor {
  range: Range;
  red: number | null;
  green: number | null;
  blue: number | null;
  alpha: number | null;
}

/** One way to write the picked color: a menu label and the document changes it makes. */
export interface ColorChoice {
  label: string;
  changes: { from: number; to: number; insert: string }[];
}

type Present<C> = (chosen: C) => Promise<ColorChoice[]>;

const byte = (v: number | null) => Math.round((v ?? 0) * 255);

export class ProviderSwatch<C extends ProviderColor> extends GutterMarker {
  constructor(
    /** Identifies the provider, so equal colors from different providers stay distinct. */
    readonly source: string,
    readonly color: C,
    readonly view: EditorView,
    readonly present: Present<C>,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return (
      other instanceof ProviderSwatch &&
      this.source === other.source &&
      JSON.stringify(this.color) === JSON.stringify(other.color)
    );
  }
  override toDOM() {
    const { red, green, blue, alpha } = this.color;
    const el = document.createElement("button");
    el.type = "button";
    el.className = this.view.state.readOnly ? styles.swatch! : `${styles.swatch} ${styles.editable}`;
    el.title = `rgba(${byte(red)}, ${byte(green)}, ${byte(blue)}, ${Number((alpha ?? 1).toFixed(2))})`;
    el.setAttribute("aria-label", el.title);
    const fill = document.createElement("span");
    fill.style.background = el.title;
    el.append(fill);
    el.onclick = () => {
      if (this.view.state.readOnly) return;
      const rect = el.getBoundingClientRect();
      pickProviderColor(this.view, this.color, { x: rect.left, y: rect.bottom }, this.present);
    };
    return el;
  }
}

/**
 * Opens the picker; on commit the provider's choices are applied (one), offered in a menu (several),
 * or a hint says there is none.
 */
export function pickProviderColor<C extends ProviderColor>(
  view: EditorView,
  color: C,
  at: { x: number; y: number },
  present: Present<C>,
) {
  const text = view.state.doc;
  const initial = [byte(color.red), byte(color.green), byte(color.blue), color.alpha ?? 1] as const;
  openColorPicker({
    view,
    anchor: at,
    value: [...initial],
    onCommit: ([r, g, b, a]) => {
      if (r === initial[0] && g === initial[1] && b === initial[2] && a === initial[3]) return;
      const current = () => view.dom.isConnected && view.state.doc === text && !view.state.readOnly;
      void present({ ...color, red: r / 255, green: g / 255, blue: b / 255, alpha: a })
        .then((choices) => {
          const apply = ({ changes }: ColorChoice) => {
            if (current() && changes.length)
              view.dispatch({ changes, userEvent: "input.color", annotations: isolateHistory.of("full") });
          };
          if (!current()) return;
          if (!choices.length)
            // Tailwind presents only arbitrary values (`bg-[#f00]`), not palette classes (`bg-red-500`).
            showHint(view, "This color can't be changed with the picker", {
              pos: rangeToOffsets(text, color.range).from,
            });
          else if (choices.length === 1) apply(choices[0]!);
          else
            showContextMenu(
              at,
              choices.map((choice) => ({ label: choice.label, verbatim: true, run: () => apply(choice) })),
            );
        })
        .catch(console.warn);
    },
  });
}

/** A provider's replacement strings for the color's own range. */
export function replaceRange(view: EditorView, range: Range, labels: string[]): ColorChoice[] {
  const { from, to } = rangeToOffsets(view.state.doc, range);
  return labels.map((label) => ({ label, changes: [{ from, to, insert: label }] }));
}
