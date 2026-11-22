/**
 * Static three-pane merge preview used by the Color Scheme › Diff & Merge page. It renders the
 * real CodeMirror diff decorations (`cm-diffLine-*`), so changing a scheme colour updates the
 * preview exactly as it updates a real merge view. Unlike `GitMergeDiff` it takes plain static
 * text instead of reading git revisions, and is offered through the `mergeSchemePreview` editor
 * kind so the settings feature can use it without importing this feature.
 *
 * Each coloured line carries `data-diattr`, so a click can select the matching scheme attribute.
 */
import { useEffect, useRef } from "react";
import { EditorState, Text, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";
import type { EditorInput } from "@/workbench/contributions";
import { firstLineOf, languageFor, viewerBase } from "./cm";
import styles from "./GitLog.module.css";
import { syncMergeScroll } from "./mergeScroll";
import { MERGE_SCHEME_PREVIEW_KIND, type MergeSchemePreviewData } from "./mergeSchemePreviewKind";

export { MERGE_SCHEME_PREVIEW_KIND };
export type { MergeSchemePreviewData };

/** The folded-unchanged separator, IDEA's DiffLineSeparatorRenderer wave. */
class FoldWaveWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly attr: string,
  ) {
    super();
  }
  eq(other: FoldWaveWidget) {
    return other.label === this.label && other.attr === this.attr;
  }
  toDOM() {
    // Mirror the real collapsed-unchanged widget so the theme's wavy separator
    // (`.cm-collapsedLines > button::after`) paints with DIFF_SEPARATOR_WAVE.
    const el = document.createElement("div");
    el.className = "cm-collapsedLines";
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("data-diattr", this.attr);
    const text = document.createElement("span");
    text.className = "cm-diffCollapseLabel";
    text.textContent = this.label;
    button.append(text);
    el.append(button);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function lineAttrs(
  texts: readonly string[],
  attrs: MergeSchemePreviewData["attrs"],
): Array<Map<number, { kind: string; attr: string }>> {
  const docs = texts.map((t) => Text.of(t.split("\n")));
  const marks = docs.map(() => new Map<number, { kind: string; attr: string }>());
  // Compare each parent against the result, exactly as GitMergeDiff does.
  for (const parent of [0, 2])
    for (const chunk of Chunk.build(docs[parent]!, docs[1]!)) {
      const inserted = chunk.fromA === chunk.toA;
      const deleted = chunk.fromB === chunk.toB;
      const kind = inserted ? "inserted" : deleted ? "deleted" : "modified";
      const attr = inserted ? attrs.inserted : deleted ? attrs.deleted : attrs.modified;
      for (const [pane, from, to] of [
        [parent, chunk.fromA, chunk.toA],
        [1, chunk.fromB, chunk.toB],
      ]) {
        const doc = docs[pane!]!;
        for (let line = doc.lineAt(Math.min(from!, doc.length)); line.from < to!;) {
          marks[pane!]!.set(line.from, { kind, attr });
          if (line.number === doc.lines) break;
          line = doc.line(line.number + 1);
        }
      }
    }
  return marks;
}

export function MergeSchemePreview({ input }: { input: EditorInput }) {
  const data = input.data as MergeSchemePreviewData;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let alive = true;
    const views: EditorView[] = [];
    let stopScroll: (() => void) | undefined;
    void languageFor(data.path, firstLineOf(data.result)).then((language) => {
      if (!alive || !host.current) return;
      const texts = [data.left, data.result, data.right];
      const marks = lineAttrs(texts, data.attrs);
      for (const [i, text] of texts.entries()) {
        const pane = document.createElement("div");
        pane.className = styles.mergeDiffPane!;
        host.current.append(pane);
        const doc = Text.of(text.split("\n"));
        const foldFrom = doc.line(Math.min(data.fold.from, doc.lines)).from;
        const foldTo = doc.line(Math.min(data.fold.to, doc.lines)).to;
        const decos: Range<Decoration>[] = [...marks[i]!]
          .sort((a, b) => a[0] - b[0])
          .map(([from, m]) =>
            Decoration.line({ class: `cm-diffLine-${m.kind}`, attributes: { "data-diattr": m.attr } }).range(from),
          );
        if (foldFrom < foldTo)
          decos.push(
            Decoration.replace({
              widget: new FoldWaveWidget(data.fold.label, data.attrs.wave),
              block: true,
            }).range(foldFrom, foldTo),
          );
        views.push(
          new EditorView({
            parent: pane,
            state: EditorState.create({
              doc,
              extensions: [
                viewerBase({ readOnly: true }),
                ...(language ? [language] : []),
                EditorView.decorations.of(Decoration.set(decos, true)),
              ],
            }),
          }),
        );
      }
      stopScroll = syncMergeScroll({ ours: views[0]!, result: views[1]!, theirs: views[2]! });
    });
    return () => {
      alive = false;
      stopScroll?.();
      views.forEach((v) => v.destroy());
      element.replaceChildren();
    };
  }, [data]);
  return (
    <div className={styles.mergeDiff}>
      <div className={styles.mergeDiffLabels}>
        {data.labels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      <div className={styles.mergeDiffPanes} ref={host} />
    </div>
  );
}
