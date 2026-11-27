/**
 * Markdown with fenced code blocks highlighted in the language their info string names.
 * Each block body also carries that language as `data-language`, so a Color Scheme's
 * per-language colours apply inside it as in a file of that language.
 */
import { syntaxTree, type Language, type LanguageDescription, LanguageSupport } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export interface FencedCodeMode {
  /** `LanguageDescription.name` of the mode, as an editor's `data-language`. */
  name: string;
  language: Language | LanguageDescription;
}

/** Resolves the first word of an info string (`shell`, `json title="a"` → `json`). */
export type FencedCodeResolver = (info: string) => FencedCodeMode | null;

const marks = new Map<string, Decoration>();

function scopeMark(name: string): Decoration {
  let mark = marks.get(name);
  if (!mark) marks.set(name, (mark = Decoration.mark({ attributes: { "data-language": name } })));
  return mark;
}

/** `data-language` marks over the bodies of the fenced blocks in `ranges` whose info string resolves. */
export function fencedCodeScopes(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  resolve: FencedCodeResolver,
): DecorationSet {
  const marked: Range<Decoration>[] = [];
  let last = -1;
  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode") return;
        const info = node.node.getChild("CodeInfo");
        const body = node.node.getChild("CodeText");
        if (info && body && body.from > last) {
          const mode = resolve(state.sliceDoc(info.from, info.to).match(/^\S*/)![0]);
          if (mode) marked.push(scopeMark(mode.name).range(body.from, body.to));
          last = body.from;
        }
        return false;
      },
    });
  }
  return Decoration.set(marked, true);
}

function fencedCodeScopePlugin(resolve: FencedCodeResolver) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = fencedCodeScopes(view.state, view.visibleRanges, resolve);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState))
          this.decorations = fencedCodeScopes(update.state, update.view.visibleRanges, resolve);
      }
    },
    // Outer decorations wrap the highlight spans, so the scoped colour variables reach them.
    {
      provide: (plugin) =>
        EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    },
  );
}

export function markdownSupport(resolve: FencedCodeResolver): LanguageSupport {
  const base = markdown({ codeLanguages: (info) => resolve(info)?.language ?? null });
  return new LanguageSupport(base.language, [base.support, fencedCodeScopePlugin(resolve)]);
}
