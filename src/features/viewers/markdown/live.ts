/**
 * Live Markdown source for the preview: an editor contribution on Markdown
 * files publishes the document text (debounced while typing), the first
 * visible line of the editor (for scroll sync) and caret moves (so a Preview
 * only preview follows navigation in its hidden editor), per path.
 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { create } from "zustand";
import { registerEditorContribution } from "@/editor/api";
import { fontZoom } from "@/editor/core/cm/prefs";
import { isMarkdownPath } from "../fileKinds";
import { modeOf, useMarkdownModes } from "./modes";

export interface LiveMarkdown {
  text: string;
  /** 0-based first visible source line of the editor that scrolled last. */
  topLine: number;
  /** Bumped when the editor scrolls, so equal lines still resync. */
  scrollSeq: number;
  /** The editor's font zoom in px; the preview scales its text by the same amount. */
  fontZoom: number;
  /** 0-based caret line, set when the caret moves without an edit (navigation). */
  caretLine: number;
  /** Bumped with `caretLine`, so going to the same place again still scrolls. */
  caretSeq: number;
  /** 0-based source line at the top of a Preview only preview, once it has been shown. */
  previewLine: number | null;
}

export const useLiveMarkdown = create<Record<string, LiveMarkdown | undefined>>(() => ({}));

const TEXT_DELAY = 120;

function publish(path: string, patch: Partial<LiveMarkdown>) {
  useLiveMarkdown.setState((s) => {
    const prev = s[path] ?? {
      text: "",
      topLine: 0,
      scrollSeq: 0,
      fontZoom: 0,
      caretLine: 0,
      caretSeq: 0,
      previewLine: null,
    };
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

      private publishCaret() {
        const caretLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
        publish(path, { caretLine, caretSeq: (useLiveMarkdown.getState()[path]?.caretSeq ?? 0) + 1 });
      }

      update(u: ViewUpdate) {
        const zoom = u.state.field(fontZoom, false) ?? 0;
        if (zoom !== (u.startState.field(fontZoom, false) ?? 0)) publish(path, { fontZoom: zoom });
        if (!u.docChanged) {
          if (u.selectionSet) this.publishCaret();
          return;
        }
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

export function setPreviewLine(path: string, line: number) {
  if (useLiveMarkdown.getState()[path]?.previewLine !== line) publish(path, { previewLine: line });
}

/** The source line on screen when `path` is shown Preview only: it stands in for the hidden editor's caret. */
export function usePreviewOnlyLine(path: string | null): number | null {
  const previewOnly = useMarkdownModes((s) => path !== null && isMarkdownPath(path) && modeOf(s, path) === "preview");
  const line = useLiveMarkdown((s) => (path ? (s[path]?.previewLine ?? null) : null));
  return previewOnly ? line : null;
}

export function registerMarkdownLiveSource(): () => void {
  return registerEditorContribution({
    id: "viewers.markdownLive",
    extensions: (ctx) => (!ctx.virtual && isMarkdownPath(ctx.path) ? [livePlugin(ctx.path)] : []),
  });
}
