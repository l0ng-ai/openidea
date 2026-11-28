/** A file's text as typed, per file, for the preview beside it (published shortly after typing stops). */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";

const TEXT_DELAY = 300;

/** The live text of the files `matches` accepts, kept by an editor contribution `id`. */
export function createLiveText(id: string, matches: (path: string) => boolean) {
  const useLive = create<Record<string, string | undefined>>(() => ({}));
  const publish = (path: string, text: string) =>
    useLive.getState()[path] === text || useLive.setState({ [path]: text });
  const plugin = (path: string) =>
    ViewPlugin.fromClass(
      class {
        private timer: ReturnType<typeof setTimeout> | undefined;
        constructor(view: EditorView) {
          publish(path, view.state.doc.toString());
        }
        update(u: ViewUpdate) {
          if (!u.docChanged) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => publish(path, u.view.state.doc.toString()), TEXT_DELAY);
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    );
  const register = (): (() => void) =>
    registerEditorContribution({
      id,
      extensions: (ctx) => (!ctx.virtual && matches(ctx.path) ? [plugin(ctx.path)] : []),
    });
  return { useLive, register };
}
