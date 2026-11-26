/** Embedded highlighting and command gutter actions share the editor-provider refresh. */
import {
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type Extension,
  type EditorState,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightingFor } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import {
  iconAreaSource,
  mapLineStart,
  onNavigationProvidersChanged,
  rangeToOffsets,
  shownAgain,
  type EditorDocContext,
} from "@/editor/api";
import { pluginVisuals } from "@/editor/lsp/pluginVisuals";
import { findLanguageDescription, languageInfo, loadSupport } from "@/editor/core/cm/languages";
import { call, commands, type GutterAction, type Injection } from "@/platform/ipc";
import { gutterIconMarkup } from "@/ui/icons";
import { resolveMarkerIcon, onMarkerIconsChanged } from "./markerIcons";
import { markerIcon } from "./lineMarkerGutter";
import { hoverActionLayer, type HoverActionLayer, type PlacedHoverAction } from "./hoverActions";
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
      other.action.icon === this.action.icon &&
      other.action.tooltip === this.action.tooltip &&
      other.action.command === this.action.command &&
      other.action.argument === this.action.argument
    );
  }
  override toDOM(view: EditorView) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `${styles.marker} cm-plugin-gutter-action`;
    el.title = this.action.tooltip;
    el.setAttribute("aria-label", this.action.tooltip);
    el.innerHTML = gutterIconMarkup(markerIcon(this.action.icon)) ?? "";
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Edited since the plugin placed it: the action may no longer mean this line.
      if (!actionsCurrent(view.state)) return;
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
type PlacedAction = { pos: number; marker: ActionMarker };
const setActions = StateEffect.define<PlacedAction[]>();
/**
 * The plugins' actions and the text they were placed for. After an edit they stay where the
 * edit moved them (no flicker while typing) but are inert until the providers answer for the
 * new text: an action placed for older text may run the wrong target.
 */
const actions = StateField.define<{ placed: PlacedAction[]; text: Text | null }>({
  create: () => ({ placed: [], text: null }),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setActions)) return { placed: e.value, text: tr.state.doc };
    if (!tr.docChanged) return v;
    return { ...v, placed: v.placed.map((a) => ({ ...a, pos: mapLineStart(tr, a.pos) })) };
  },
  provide: (f) =>
    EditorView.editorAttributes.compute([f, "doc"], (state): Record<string, string> =>
      state.field(f).placed.length > 0 && !actionsCurrent(state) ? { class: "cm-plugin-actions-stale" } : {},
    ),
});
/** Whether the actions were placed for the editor's current text. */
function actionsCurrent(state: EditorState): boolean {
  return state.field(actions, false)?.text === state.doc;
}
const staleTheme = EditorView.baseTheme({
  "&.cm-plugin-actions-stale .cm-plugin-gutter-action": { opacity: "0.5", cursor: "default" },
});
/** In the shared icon area, beside the plugins' line markers. */
const actionSource = iconAreaSource.of({
  order: 65,
  markers: (view) =>
    RangeSet.of(
      view.state.field(actions).placed.map((a) => a.marker.range(a.pos)),
      true,
    ),
});
export function pluginLanguageVisuals(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    highlights,
    actions,
    actionSource,
    staleTheme,
    ViewPlugin.define(
      (view) =>
        new (class {
          timer: ReturnType<typeof setTimeout> | undefined;
          generation = 0;
          skipped = false;
          off: () => void;
          hover: HoverActionLayer;
          constructor() {
            this.hover = hoverActionLayer(view, ctx);
            const a = onNavigationProvidersChanged(() => this.schedule());
            const b = onMarkerIconsChanged(() => this.schedule());
            this.off = () => {
              a();
              b();
            };
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
            const generation = this.generation;
            const text = view.state.doc;
            try {
              const result = await pluginVisuals(view, ctx);
              const deco = await injectedHighlights(view.state, result.injections);
              const hover = await Promise.all(
                (result.hoverActions ?? []).map(async ([plugin, a]) => ({
                  plugin,
                  action: { ...a, icon: await resolveMarkerIcon(plugin, a.icon) },
                })),
              );
              const placed = await Promise.all(
                result.gutterActions
                  .filter(([, a]) => a.line < text.lines)
                  .map(async ([plugin, a]) => ({
                    pos: text.line(a.line + 1).from,
                    marker: new ActionMarker(plugin, { ...a, icon: await resolveMarkerIcon(plugin, a.icon) }, ctx),
                  })),
              );
              if (generation !== this.generation || view.state.doc !== text) return;
              this.skipped = !view.dom.isConnected;
              if (this.skipped) return;
              view.dispatch({ effects: [setHighlight.of(deco), setActions.of(placed)] });
              this.hover.set(hover as PlacedHoverAction[]);
            } catch (error) {
              console.debug("[plugin language visuals]", error);
            }
          }
          destroy() {
            this.generation++;
            clearTimeout(this.timer);
            this.off();
            this.hover.destroy();
          }
        })(),
    ),
  ];
}
