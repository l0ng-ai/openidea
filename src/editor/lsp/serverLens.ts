/**
 * Code lenses the language service computes (`lsp_code_lens`), for the
 * languages whose lenses the client can run: PHP, where the native engine
 * lists the Laravel routes pointing to each controller method. Fetched after
 * a pause in typing and kept on their lines meanwhile; a click runs the
 * lens's command (`clientCommands`).
 */
import { MapMode, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { codeLenses, type CodeLens } from "@/editor/api";
import { commands, type CodeLens as ServerLens } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { debounce, docOf, isUnavailable, lspRequest } from "./lsp";
import { posToOffset } from "./positions";
import { featureBackoff, onLspRefresh } from "./availability";
import { runCommand } from "./clientCommands";

/** Languages whose service lenses are shown. */
const SERVER_LENS_LANGUAGES = new Set(["php"]);

const backoff = featureBackoff();

const setLenses = StateEffect.define<CodeLens[]>();

const serverLensField = StateField.define<CodeLens[]>({
  create: () => [],
  update(lenses, tr) {
    for (const e of tr.effects) if (e.is(setLenses)) return e.value;
    if (!tr.docChanged || !lenses.length) return lenses;
    const out: CodeLens[] = [];
    for (const l of lenses) {
      const pos = tr.changes.mapPos(l.pos, -1, MapMode.TrackDel);
      if (pos !== null) out.push({ ...l, pos });
    }
    return out;
  },
  provide: (f) => codeLenses.from(f),
});

/** The editor lenses of the service's lenses with a command. Exported for tests. */
export function editorLenses(view: EditorView, lenses: readonly ServerLens[]): CodeLens[] {
  const out: CodeLens[] = [];
  for (const lens of lenses) {
    const command = lens.command;
    if (!command?.title) continue;
    out.push({
      pos: posToOffset(view.state.doc, lens.range.start),
      title: command.title,
      order: 30,
      run: (v, event) => void runCommand(v, command, event),
    });
  }
  return out;
}

const serverLensPlugin = ViewPlugin.fromClass(
  class {
    private refresh = debounce(() => void this.run(), 700);
    private generation = 0;
    private offRefresh: () => void;
    private unsubscribe: () => void;
    constructor(private view: EditorView) {
      this.refresh();
      this.offRefresh = onLspRefresh("codeLens", () => this.refresh());
      this.unsubscribe = useProject.subscribe((s, prev) => {
        if (s.settings !== prev.settings) this.refresh();
      });
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.refresh();
    }
    async run() {
      const view = this.view;
      if (!view.dom.isConnected) return;
      const doc = docOf(view);
      if (!doc || doc.virtual || !SERVER_LENS_LANGUAGES.has(doc.language) || backoff.active(doc.doc)) return;
      const gen = ++this.generation;
      const text = view.state.doc;
      const wanted = () => gen === this.generation && view.state.doc === text;
      try {
        const lenses = await lspRequest(() => commands.lspCodeLens(doc.doc), wanted);
        if (!wanted()) return;
        const next = editorLenses(view, lenses);
        const current = view.state.field(serverLensField);
        const same =
          current.length === next.length &&
          current.every((l, i) => l.pos === next[i]!.pos && l.title === next[i]!.title);
        if (!same) view.dispatch({ effects: setLenses.of(next) });
      } catch (e) {
        if (wanted() && isUnavailable(e)) backoff.mark(doc.doc);
      }
    }
    destroy() {
      this.generation++;
      this.refresh.cancel();
      this.offRefresh();
      this.unsubscribe();
    }
  },
);

export function serverLensExtension(): Extension {
  return [serverLensField, serverLensPlugin];
}
