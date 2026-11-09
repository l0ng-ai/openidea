/** Embedded highlighting and command gutter actions share the editor-provider refresh. */
import {
  Compartment,
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type EditorState,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { type EditorDocContext } from "@/editor/api";
import { rangeToOffsets } from "@/editor/lsp/positions";
import { pluginVisuals } from "@/editor/lsp/pluginVisuals";
import { findLanguageDescription, languageInfo, loadSupport } from "@/editor/core/cm/languages";
import { onNavigationProvidersChanged } from "@/editor/navigationProviders";
import { call, commands, type GutterAction, type Injection } from "@/platform/ipc";
import { gutterIconMarkup } from "@/ui/icons";
import { resolveMarkerIcon, onMarkerIconsChanged } from "./markerIcons";
import { markerIcon } from "./lineMarkerGutter";
import styles from "@/editor/navigation/LineMarkers.module.css";

export async function injectedHighlights(state: EditorState, injections: readonly Injection[]): Promise<DecorationSet> {
  const ranges = await Promise.all(
    injections.map(async (i) => {
      const { from, to } = rangeToOffsets(state.doc, i.range);
      if (from >= to) return [];
      const desc = findLanguageDescription(languageInfo(i.language)?.uiMode ?? i.language, "");
      const support = desc ? await loadSupport(desc) : null;
      if (!support) return [];
      const marks = [] as ReturnType<Decoration["range"]>[];
      highlightTree(
        support.language.parser.parse(state.sliceDoc(from, to)),
        { style: (tags) => highlightingFor(state, tags) },
        (a, b, cls) => marks.push(Decoration.mark({ class: cls }).range(from + a, from + b)),
      );
      return marks;
    }),
  );
  return Decoration.set(ranges.flat(), true);
}
const setHighlight = StateEffect.define<DecorationSet>();
const highlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHighlight)) return e.value;
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (f) => Prec.high(EditorView.decorations.from(f)),
});
class ActionMarker extends GutterMarker {
  constructor(
    readonly plugin: string,
    readonly action: GutterAction,
    readonly ctx: EditorDocContext,
  ) {
    super();
  }
  override eq(other: GutterMarker) {
    return (
      other instanceof ActionMarker &&
      other.plugin === this.plugin &&
      JSON.stringify(other.action) === JSON.stringify(this.action)
    );
  }
  override toDOM() {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `${styles.marker} cm-plugin-gutter-action`;
    el.title = this.action.tooltip;
    el.setAttribute("aria-label", this.action.tooltip);
    el.innerHTML = gutterIconMarkup(markerIcon(this.action.icon)) ?? "";
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void call(
        commands.lspExecuteCommand(this.ctx.doc, {
          title: this.action.tooltip,
          command: `openidea.plugin-language:${this.plugin}:${this.action.command}`,
          arguments: [JSON.stringify(this.action.argument)],
        }),
      ).catch(console.warn);
    };
    return el;
  }
}
const setActions = StateEffect.define<{ pos: number; marker: ActionMarker }[]>();
const actions = StateField.define<{ pos: number; marker: ActionMarker }[]>({
  create: () => [],
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setActions)) return e.value;
    return tr.docChanged ? [] : v;
  },
});
const column = gutter({
  class: `${styles.gutter} cm-plugin-gutter-actions`,
  markers: (view) =>
    RangeSet.of(
      view.state.field(actions).map((a) => a.marker.range(a.pos)),
      true,
    ),
});
export function pluginLanguageVisuals(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  const compartment = new Compartment();
  return [
    highlights,
    actions,
    compartment.of([]),
    ViewPlugin.define(
      (view) =>
        new (class {
          timer: ReturnType<typeof setTimeout> | undefined;
          generation = 0;
          shown = false;
          off: () => void;
          constructor() {
            const a = onNavigationProvidersChanged(() => this.schedule(true));
            const b = onMarkerIconsChanged(() => this.schedule());
            this.off = () => {
              a();
              b();
            };
            this.schedule();
          }
          schedule(clear = false) {
            this.generation++;
            clearTimeout(this.timer);
            if (clear)
              queueMicrotask(() => {
                if (view.dom.isConnected)
                  view.dispatch({
                    effects: [setHighlight.of(Decoration.none), setActions.of([]), compartment.reconfigure([])],
                  });
                this.shown = false;
              });
            this.timer = setTimeout(() => void this.run(), 300);
          }
          update(u: ViewUpdate) {
            if (u.docChanged) this.schedule();
          }
          async run() {
            const generation = this.generation;
            const text = view.state.doc;
            try {
              const result = await pluginVisuals(view, ctx);
              const deco = await injectedHighlights(view.state, result.injections);
              const placed = await Promise.all(
                result.gutterActions
                  .filter(([, a]) => a.line < text.lines)
                  .map(async ([plugin, a]) => ({
                    pos: text.line(a.line + 1).from,
                    marker: new ActionMarker(plugin, { ...a, icon: await resolveMarkerIcon(plugin, a.icon) }, ctx),
                  })),
              );
              if (generation !== this.generation || view.state.doc !== text || !view.dom.isConnected) return;
              this.shown = !!placed.length;
              view.dispatch({
                effects: [
                  setHighlight.of(deco),
                  setActions.of(placed),
                  compartment.reconfigure(this.shown ? column : []),
                ],
              });
            } catch {
              if (generation === this.generation && view.dom.isConnected)
                view.dispatch({
                  effects: [setHighlight.of(Decoration.none), setActions.of([]), compartment.reconfigure([])],
                });
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
