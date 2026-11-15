/** Language-server and plugin lenses in the shared editor code-vision renderer. */
import { MapMode, StateEffect, StateField, type Extension } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { codeLenses, shownAgain, whenSynced, type CodeLens, type EditorDocContext } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import { onNavigationProvidersChanged } from "@/editor/navigationProviders";
import { posToOffset } from "./positions";
import { onLspRefresh, onServerSettled, anyServerBusy } from "./availability";
/**
 * A server's reference count ("3 references", csharp-ls's "3 Reference(s)"): Code Vision's
 * Usages shows the same count above the declaration, under its own setting.
 */
const REFERENCE_COUNT = /^\s*\d+\s+references?(\(s\))?\s*$/i;

const set = StateEffect.define<CodeLens[]>();
const field = StateField.define<CodeLens[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(set)) return e.value;
    // Map through edits so block widgets don't vanish/reappear and thrash scroll (#2710).
    if (!tr.docChanged || !value.length) return value;
    const out: CodeLens[] = [];
    for (const l of value) {
      const pos = tr.changes.mapPos(l.pos, -1, MapMode.TrackDel);
      if (pos !== null) out.push({ ...l, pos });
    }
    return out;
  },
  provide: (f) => codeLenses.from(f),
});
export function serverCodeLenses(ctx: EditorDocContext): Extension {
  if (ctx.doc < 0) return [];
  return [
    field,
    ViewPlugin.define(
      (view) =>
        new (class {
          timer: ReturnType<typeof setTimeout> | undefined;
          generation = 0;
          skipped = false;
          off: () => void;
          constructor() {
            const offs = [
              onNavigationProvidersChanged(() => this.schedule()),
              onLspRefresh("codeLens", () => this.schedule()),
              onServerSettled(() => this.schedule()),
            ];
            this.off = () => offs.forEach((f) => f());
            this.schedule();
          }
          schedule() {
            this.generation++;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => void this.run(), 400);
          }
          update(u: ViewUpdate) {
            if (u.docChanged || (this.skipped && shownAgain(u))) this.schedule();
          }
          async run() {
            const gen = this.generation;
            const text = view.state.doc;
            try {
              await whenSynced(view);
              const result = await call(commands.lspCodeLens(ctx.doc));
              if (gen !== this.generation || text !== view.state.doc) return;
              this.skipped = !view.dom.isConnected;
              if (this.skipped) return;
              const fresh = result.flatMap((l) =>
                l.command && !REFERENCE_COUNT.test(l.command.title)
                  ? [
                      {
                        pos: posToOffset(text, l.range.start),
                        title: l.command.title,
                        run: () => {
                          void call(commands.lspExecuteCommand(ctx.doc, l.command!)).catch(console.warn);
                        },
                      },
                    ]
                  : [],
              );
              // A busy server (indexing, loading) can answer with nothing: keep the
              // lenses shown until it settles, instead of blinking the rows away.
              // A partial non-empty answer is applied as-is.
              if (!fresh.length && view.state.field(field).length && anyServerBusy()) return;
              view.dispatch({ effects: set.of(fresh) });
            } catch {
              // A failed request while a server is starting or busy: keep the lenses until it
              // settles. Otherwise the server is gone and so are its lenses.
              if (gen === this.generation && view.dom.isConnected && !anyServerBusy())
                view.dispatch({ effects: set.of([]) });
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
