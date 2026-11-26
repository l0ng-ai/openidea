/** Plugin colors use the shared picker and provider-supplied replacement strings. */
import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import { onNavigationProvidersChanged, shownAgain, type EditorDocContext } from "@/editor/api";
import { pluginVisuals } from "@/editor/lsp/pluginVisuals";
import { call, commands, type ColorInfo } from "@/platform/ipc";
import { ProviderSwatch, replaceRange } from "./providerSwatch";
import styles from "./ColorPreview.module.css";
const setColors = StateEffect.define<[string, ColorInfo][]>();
const colors = StateField.define<[string, ColorInfo][]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setColors)) return e.value;
    return tr.docChanged ? [] : v;
  },
});
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
            .map(([p, c]) =>
              new ProviderSwatch(`plugin:${p}`, c, view, async (chosen) =>
                replaceRange(view, c.range, await call(commands.pluginColorPresentations(ctx.doc, p, chosen))),
              ).range(view.state.doc.line(c.range.start.line + 1).from),
            ),
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
