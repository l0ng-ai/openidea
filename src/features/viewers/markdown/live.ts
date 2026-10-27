/**
 * Live Markdown source for the preview: an editor contribution on Markdown
 * files publishes the document text (debounced while typing) and the first
 * visible line of the editor (for scroll sync), per path.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { fontZoom } from "@/editor/core/cm/prefs";
import { isMarkdownPath } from "../fileKinds";

export interface LiveMarkdown {
  text: string;
  /** 0-based first visible source line of the editor that scrolled last. */
  topLine: number;
  /** Bumped when the editor scrolls, so equal lines still resync. */
  scrollSeq: number;
  /** The editor's font zoom in px; the preview scales its text by the same amount. */
  fontZoom: number;
}

export const useLiveMarkdown = create<Record<string, LiveMarkdown | undefined>>(() => ({}));

const TEXT_DELAY = 120;

function publish(path: string, patch: Partial<LiveMarkdown>) {
  useLiveMarkdown.setState((s) => {
    const prev = s[path] ?? { text: "", topLine: 0, scrollSeq: 0, fontZoom: 0 };
    return { [path]: { ...prev, ...patch } };
  });
}

function topLineOf(view: EditorView): number {
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  return view.state.doc.lineAt(block.from).number - 1;
}

function livePlugin(path: string) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      private frame = 0;
      private readonly onScroll = () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
          this.frame = 0;
          const seq = (useLiveMarkdown.getState()[path]?.scrollSeq ?? 0) + 1;
          publish(path, { topLine: topLineOf(this.view), scrollSeq: seq });
        });
      };

      constructor(private view: EditorView) {
        publish(path, { text: view.state.doc.toString(), fontZoom: view.state.field(fontZoom, false) ?? 0 });
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
      }

      update(u: ViewUpdate) {
        const zoom = u.state.field(fontZoom, false) ?? 0;
        if (zoom !== (u.startState.field(fontZoom, false) ?? 0)) publish(path, { fontZoom: zoom });
        if (!u.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => publish(path, { text: this.view.state.doc.toString() }), TEXT_DELAY);
      }

      destroy() {
        clearTimeout(this.timer);
        cancelAnimationFrame(this.frame);
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        // Flush the latest edit for a preview that outlives this view.
        publish(path, { text: this.view.state.doc.toString() });
      }
    },
  );
}

export function registerMarkdownLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.markdownLive",
    extensions: (ctx) => (!ctx.virtual && isMarkdownPath(ctx.path) ? [livePlugin(ctx.path)] : []),
  });
}
