import { useEffect, useRef, useState } from "react";
import { EditorState, Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";
import { call, commands } from "@/platform/ipc";
import type { EditorInput } from "@/workbench/contributions";
import { languageFor, viewerBase } from "./cm";
import { repositoryPath } from "./repositoryPaths";
import styles from "./GitLog.module.css";
import { syncMergeScroll } from "./mergeScroll";

/** Read-only parent / merge result / parent comparison, independent of the worktree. */
export function GitMergeDiff({ input }: { input: EditorInput }) {
  const data = input.data as {
    repo: string;
    revision: string;
    path: string;
    parents: Array<{ rev: string; path: string }>;
  };
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const views: EditorView[] = [];
    let stopScroll: (() => void) | undefined;
    const sides = [data.parents[0]!, { rev: data.revision, path: data.path }, data.parents[1]!];
    void Promise.all([
      Promise.all(sides.map((s) => call(commands.vcsFileAt(repositoryPath(data.repo, s.path), s.rev)))),
      languageFor(data.path),
    ])
      .then(([texts, language]) => {
        if (!alive || !host.current) return;
        const docs = texts.map((text) => Text.of((text ?? "").split("\n")));
        const marks = docs.map(() => new Map<number, string>());
        for (const parent of [0, 2])
          for (const chunk of Chunk.build(docs[parent]!, docs[1]!)) {
            for (const [pane, from, to] of [
              [parent, chunk.fromA, chunk.toA],
              [1, chunk.fromB, chunk.toB],
            ]) {
              const doc = docs[pane!]!;
              for (let line = doc.lineAt(Math.min(from!, doc.length)); line.from < to!;) {
                marks[pane!]!.set(
                  line.from,
                  chunk.fromA === chunk.toA ? "inserted" : chunk.fromB === chunk.toB ? "deleted" : "modified",
                );
                if (line.number === doc.lines) break;
                line = doc.line(line.number + 1);
              }
            }
          }
        for (const [i, text] of texts.entries()) {
          const pane = document.createElement("div");
          pane.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column";
          const label = document.createElement("div");
          label.textContent = `${sides[i]!.rev.slice(0, 8)} · ${sides[i]!.path}`;
          pane.append(label);
          host.current.append(pane);
          const view = new EditorView({
            parent: pane,
            state: EditorState.create({
              doc: text ?? "",
              extensions: [
                viewerBase({ readOnly: true }),
                ...(language ? [language] : []),
                EditorView.decorations.of(
                  Decoration.set(
                    [...marks[i]!]
                      .sort((a, b) => a[0] - b[0])
                      .map(([from, kind]) => Decoration.line({ class: `cm-diffLine-${kind}` }).range(from)),
                  ),
                ),
              ],
            }),
          });
          views.push(view);
        }
        stopScroll = syncMergeScroll({ ours: views[0]!, result: views[1]!, theirs: views[2]! });
      })
      .catch((e) => alive && setError(String(e)));
    const element = host.current;
    return () => {
      alive = false;
      stopScroll?.();
      views.forEach((v) => v.destroy());
      element?.replaceChildren();
    };
  }, [data]);
  return (
    <>
      <div role={error ? "alert" : undefined}>{error}</div>
      <div className={styles.revisionSource} style={{ display: "flex" }} ref={host} />
    </>
  );
}
