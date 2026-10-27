/**
 * Editor contribution: TODO comments coloured by pattern with a bold
 * keyword (visible ranges, comment nodes only), and live TODO items of the
 * open document for the tool window.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { activePatterns, scanText, todoRegexSource, type TodoSettings } from "./model";
import { setLiveTodos, useTodoSettings } from "./store";

const LIVE_SCAN_LIMIT = 2_000_000;

function compile(s: TodoSettings): { re: RegExp; colors: Map<string, string> } | null {
  const source = todoRegexSource(s);
  if (!source) return null;
  const colors = new Map<string, string>();
  for (const p of activePatterns(s))
    colors.set(s.caseSensitive ? p.keyword.trim() : p.keyword.trim().toLowerCase(), p.color);
  // Keyword only; the decoration runs to the end of the comment line.
  return { re: new RegExp(source.replace(/\.\*$/, ""), s.caseSensitive ? "gu" : "giu"), colors };
}

const markCache = new Map<string, { line: Decoration; keyword: Decoration }>();
function marks(color: string) {
  let m = markCache.get(color);
  if (!m) {
    m = {
      line: Decoration.mark({ class: "cm-openidea-todo", attributes: { style: `--todo-color: ${color}` } }),
      keyword: Decoration.mark({ class: "cm-openidea-todo-keyword" }),
    };
    markCache.set(color, m);
  }
  return m;
}

export function todoDecorations(view: EditorView, settings: TodoSettings): DecorationSet {
  const compiled = compile(settings);
  if (!compiled) return Decoration.none;
  const { re, colors } = compiled;
  const { state } = view;
  const tree = syntaxTree(state);
  const found: Array<{ from: number; kwEnd: number; to: number; color: string }> = [];
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (!/comment/i.test(node.name)) return;
        const start = Math.max(node.from, from);
        const end = Math.min(node.to, to);
        const text = state.sliceDoc(start, end);
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const kwFrom = start + m.index!;
          const kwEnd = kwFrom + m[0].length;
          const lineEnd = Math.min(state.doc.lineAt(kwFrom).to, node.to);
          const key = settings.caseSensitive ? m[1]! : m[1]!.toLowerCase();
          found.push({ from: kwFrom, kwEnd, to: lineEnd, color: colors.get(key) ?? "var(--info)" });
        }
        return false;
      },
    });
  }
  found.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const f of found) {
    if (f.from < last) continue;
    // Trim a trailing block-comment close from the coloured range.
    let to = f.to;
    const tail = state.sliceDoc(f.kwEnd, to);
    const close = /\s*(\*\/|-->|-\}|\*\))\s*$/.exec(tail);
    if (close) to = f.kwEnd + close.index;
    const m = marks(f.color);
    builder.add(f.from, Math.max(to, f.kwEnd), m.line);
    builder.add(f.from, f.kwEnd, m.keyword);
    last = Math.max(to, f.kwEnd);
  }
  return builder.finish();
}

const theme = EditorView.baseTheme({
  ".cm-openidea-todo, .cm-openidea-todo *": { color: "var(--todo-color) !important", fontStyle: "italic" },
  ".cm-openidea-todo-keyword, .cm-openidea-todo-keyword *": { fontWeight: "var(--fw-code-bold, 700)", fontStyle: "normal" },
});

export function todoEditorExtension(ctx: EditorDocContext): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      settings = useTodoSettings.getState();
      timer: ReturnType<typeof setTimeout> | null = null;
      unsub: () => void;
      constructor(readonly view: EditorView) {
        this.decorations = todoDecorations(view, this.settings);
        this.unsub = useTodoSettings.subscribe((s) => {
          this.settings = s;
          this.decorations = todoDecorations(view, s);
          view.dispatch({});
          this.scheduleLive(0);
        });
        this.scheduleLive(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState))
          this.decorations = todoDecorations(u.view, this.settings);
        if (u.docChanged) this.scheduleLive(400);
      }
      scheduleLive(delay: number) {
        if (!ctx.path || ctx.virtual) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          const doc = this.view.state.doc;
          if (doc.length > LIVE_SCAN_LIMIT) return;
          setLiveTodos(ctx.path, scanText(ctx.path, doc.toString(), this.settings));
        }, delay);
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.unsub();
      }
    },
    { decorations: (v) => v.decorations },
  );
  return [plugin, theme];
}
