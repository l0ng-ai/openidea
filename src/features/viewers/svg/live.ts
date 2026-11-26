/** The SVG source as typed, per file, for the preview beside it (redrawn shortly after typing stops). */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { isSvgPath } from "../fileKinds";

export const useLiveSvg = create<Record<string, string | undefined>>(() => ({}));

const TEXT_DELAY = 300;

const publish = (path: string, text: string) =>
  useLiveSvg.getState()[path] === text || useLiveSvg.setState({ [path]: text });

function livePlugin(path: string) {
  return ViewPlugin.fromClass(
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
}

export function registerSvgLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.svgLive",
    extensions: (ctx) => (!ctx.virtual && isSvgPath(ctx.path) ? [livePlugin(ctx.path)] : []),
  });
}
