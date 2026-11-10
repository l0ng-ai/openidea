/** Plugin colors use the shared picker and provider-supplied replacement strings. */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { GutterMarker, ViewPlugin, gutter, type EditorView, type ViewUpdate } from "@codemirror/view";
import { shownAgain, type EditorDocContext } from "@/editor/api";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { pluginVisuals } from "@/editor/lsp/pluginVisuals";
import { onNavigationProvidersChanged } from "@/editor/navigationProviders";
import { call, commands, type ColorInfo } from "@/platform/ipc";
import { showContextMenu } from "@/ui";
import { openColorPicker } from "./ColorPicker";
import styles from "./ColorPreview.module.css";
const setColors = StateEffect.define<[string, ColorInfo][]>();
const colors = StateField.define<[string, ColorInfo][]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setColors)) return e.value;
    return tr.docChanged ? [] : v;
  },
});
class Swatch extends GutterMarker {
  constructor(
    readonly plugin: string,
    readonly color: ColorInfo,
    readonly view: EditorView,
    readonly ctx: EditorDocContext,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return (
      other instanceof Swatch &&
      this.plugin === other.plugin &&
      JSON.stringify(this.color) === JSON.stringify(other.color)
    );
  }
  override toDOM() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = styles.swatch!;
    el.title = `rgba(${this.color.red}, ${this.color.green}, ${this.color.blue}, ${this.color.alpha})`;
    el.setAttribute("aria-label", el.title);
    const fill = document.createElement("span");
    fill.style.background = `rgba(${(this.color.red ?? 0) * 255}, ${(this.color.green ?? 0) * 255}, ${(this.color.blue ?? 0) * 255}, ${this.color.alpha})`;
    el.append(fill);
    el.onclick = () => {
      if (this.view.state.readOnly) return;
      const rect = el.getBoundingClientRect();
      pick(this.view, this.ctx, this.plugin, this.color, rect.left, rect.bottom);
    };
    return el;
  }
}
function pick(view: EditorView, ctx: EditorDocContext, plugin: string, color: ColorInfo, x: number, y: number) {
  const text = view.state.doc;
  const { from, to } = rangeToOffsets(text, color.range);
  const initial = [
    Math.round((color.red ?? 0) * 255),
    Math.round((color.green ?? 0) * 255),
    Math.round((color.blue ?? 0) * 255),
    color.alpha ?? 1,
  ] as const;
  openColorPicker({
    view,
    anchor: { x, y },
    value: [...initial],
    onCommit: ([r, g, b, a]) => {
      if (r === initial[0] && g === initial[1] && b === initial[2] && a === initial[3]) return;
      const chosen = {
        ...color,
        red: r / 255,
        green: g / 255,
        blue: b / 255,
        alpha: a,
      };
      void call(commands.pluginColorPresentations(ctx.doc, plugin, chosen))
        .then((list) => {
          const apply = (insert: string) => {
            if (view.state.doc === text && !view.state.readOnly)
              view.dispatch({ changes: { from, to, insert }, userEvent: "input.color" });
          };
          if (view.state.doc !== text) return;
          if (list.length === 1) apply(list[0]!);
          else if (list.length)
            showContextMenu(
              { x, y },
              list.map((label) => ({ label, verbatim: true, run: () => apply(label) })),
            );
        })
        .catch(console.warn);
    },
  });
}
export function pluginColorPreview(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    colors,
    gutter({
      class: `${styles.gutter} cm-plugin-color-preview`,
      markers: (view) =>
        RangeSet.of(
          view.state
            .field(colors)
            .map(([p, c]) => new Swatch(p, c, view, ctx).range(view.state.doc.line(c.range.start.line + 1).from)),
          true,
        ),
    }),
    ViewPlugin.define(
      (view) =>
        new (class {
          timer: ReturnType<typeof setTimeout> | undefined;
          generation = 0;
          skipped = false;
          off: () => void;
          constructor() {
            this.off = onNavigationProvidersChanged(() => this.schedule());
            this.schedule();
          }
          schedule() {
            this.generation++;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => void this.run(), 300);
          }
          update(u: ViewUpdate) {
            if (u.docChanged || (this.skipped && shownAgain(u))) this.schedule();
          }
          async run() {
            const gen = this.generation;
            const text = view.state.doc;
            try {
              const r = await pluginVisuals(view, ctx);
              if (gen !== this.generation || view.state.doc !== text) return;
              this.skipped = !view.dom.isConnected;
              if (!this.skipped) view.dispatch({ effects: setColors.of(r.colors) });
            } catch {
              if (gen === this.generation && view.dom.isConnected) view.dispatch({ effects: setColors.of([]) });
            }
          }
          destroy() {
            this.generation++;
            clearTimeout(this.timer);
            this.off();
          }
        })(),
    ),
  ];
}
