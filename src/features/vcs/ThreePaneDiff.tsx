import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, RangeSet, Transaction } from "@codemirror/state";
import { Decoration, EditorView, gutter } from "@codemirror/view";
import { Chunk } from "@codemirror/merge";
import { diffSideExtensions, embeddedEditorExtensions, remoteChange, type DocumentAttachment } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { documentTooltips, firstLineOf, languageFor, viewerBase } from "./cm";
import { diffDocument, exposeHunkButtons, HunkButtons, type HunkButton } from "./diffControls";
import { ideaDiffConfig } from "./diffOptions";
import { syncMergeScroll } from "./mergeScroll";
import { diffRangeView, setDiffRange } from "./diffRangeView";
import type { DiffRange } from "./stagingRange";
import type { StagedDocument } from "./stagedDocument";
import diffStyles from "./DiffEditor.module.css";
import styles from "./ThreePaneDiff.module.css";

export type ThreePanes<T> = readonly [T, T, T];
export type PaneIndex = 0 | 1 | 2;
const PANES = [0, 1, 2] as const;
const PAIRS = [0, 1] as const;
const LINES = ideaDiffConfig("none", "lines");

export interface ThreePaneChange {
  pair: 0 | 1;
  chunk: Chunk;
}

export function compareThreeTexts(texts: ThreePanes<string | null>, ranges?: ThreePanes<DiffRange>) {
  const docs = [diffDocument(texts[0]), diffDocument(texts[1]), diffDocument(texts[2])] as const;
  const visible = (i: PaneIndex) => (ranges ? docs[i].slice(ranges[i].from, ranges[i].to) : docs[i]);
  const binary = texts.some((text) => text?.includes("\0"));
  const changes: ThreePaneChange[] = binary
    ? []
    : PAIRS.flatMap((pair) =>
        Chunk.build(visible(pair), visible(pair === 0 ? 1 : 2), LINES).map((chunk) => ({ pair, chunk })),
      );
  changes.sort((a, b) => centerOffset(a) - centerOffset(b) || a.pair - b.pair);
  return { texts, docs, changes, binary, ranges };
}

function centerOffset(change: ThreePaneChange): number {
  return change.pair === 0 ? change.chunk.fromB : change.chunk.fromA;
}

export interface HunkControl extends HunkButton {
  pane: PaneIndex;
}

interface PaneViews {
  editors: ThreePanes<EditorView>;
  presentation: ThreePanes<Compartment>;
  local: DocumentAttachment | null;
  index: StagedDocument | null;
}

function markChanges(model: ReturnType<typeof compareThreeTexts>) {
  const marks = PANES.map(() => new Map<number, string>());
  for (const { pair, chunk } of model.changes) {
    const kind = chunk.fromA === chunk.toA ? "inserted" : chunk.fromB === chunk.toB ? "deleted" : "modified";
    for (const [pane, from, to] of [
      [pair, chunk.fromA, chunk.toA],
      [pair + 1, chunk.fromB, chunk.toB],
    ] as const) {
      const doc = model.docs[pane]!;
      const offset = model.ranges?.[pane]?.from ?? 0;
      const limit = Math.min(offset + to, (model.ranges?.[pane]?.to ?? doc.length) + 1);
      for (
        let line = doc.lineAt(Math.min(offset + from, doc.length));
        line.from < limit;
        line = doc.line(line.number + 1)
      ) {
        marks[pane]!.set(line.from, kind);
        if (line.number === doc.lines) break;
      }
    }
  }
  return marks.map((pane) =>
    Decoration.set(
      [...pane].map(([from, kind]) => Decoration.line({ class: `cm-diffLine-${kind}` }).range(from)),
      true,
    ),
  );
}

function present(
  panes: PaneViews,
  model: ReturnType<typeof compareThreeTexts>,
  controls: ((change: ThreePaneChange) => HunkControl[]) | undefined,
) {
  const marks = markChanges(model);
  const buttons = PANES.map(() => new Map<number, HunkControl[]>());
  for (const change of model.changes) {
    for (const control of controls?.(change) ?? []) {
      const doc = model.docs[control.pane];
      const offset =
        (control.pane === change.pair ? change.chunk.fromA : change.chunk.fromB) +
        (model.ranges?.[control.pane].from ?? 0);
      const from = doc.lineAt(Math.min(doc.length, offset)).from;
      const line = buttons[control.pane]!;
      line.set(from, [...(line.get(from) ?? []), control]);
    }
  }
  for (const i of PANES) {
    const view = panes.editors[i];
    const doc = model.docs[i];
    // The attachment owns the local document. A preview from the diff is never written back.
    if (((i === 2 && panes.local) || (i === 1 && panes.index)) && !view.state.doc.eq(doc)) continue;
    const markers = RangeSet.of(
      [...buttons[i]!].map(([from, line]) => new HunkButtons(line).range(from)),
      true,
    );
    view.dispatch({
      changes: view.state.doc.eq(doc) ? undefined : { from: 0, to: view.state.doc.length, insert: doc },
      effects: [
        panes.presentation[i].reconfigure([
          EditorView.decorations.of(marks[i]!),
          markers.size
            ? gutter({ class: diffStyles.hunkGutter, markers: () => markers, side: i === 2 ? "before" : "after" })
            : [],
        ]),
        setDiffRange.of(model.ranges?.[i] ?? null),
      ],
      annotations: [Transaction.addToHistory.of(false), remoteChange.of(true)],
    });
    exposeHunkButtons(view);
  }
}

export function ThreePaneDiff({
  path,
  labels,
  model,
  controls,
  onEditors,
  local = null,
  index = null,
  onLocalText,
}: {
  path: string;
  labels: ThreePanes<string>;
  model: ReturnType<typeof compareThreeTexts> | null;
  controls?: (change: ThreePaneChange) => HunkControl[];
  onEditors?: (views: ThreePanes<EditorView> | null) => void;
  local?: DocumentAttachment | null;
  index?: StagedDocument | null;
  onLocalText?: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const views = useRef<PaneViews | null>(null);
  const latest = useRef({ model, controls, onEditors, onLocalText });
  useLayoutEffect(() => {
    latest.current = { model, controls, onEditors, onLocalText };
  }, [model, controls, onEditors, onLocalText]);
  const ready = !!model && !model.binary;
  useLayoutEffect(() => {
    if (views.current?.local === local && views.current?.index === index && model && !model.binary)
      present(views.current, model, controls);
  }, [model, local, index, controls]);
  useEffect(() => {
    const initial = latest.current.model;
    if (!ready || !initial || !host.current) return;
    const element = host.current;
    let alive = true;
    let stopScroll: (() => void) | undefined;
    let reportEdit: ReturnType<typeof setTimeout> | undefined;
    const sample = initial.texts[1] ?? initial.texts[2] ?? initial.texts[0];
    void languageFor(path, sample === null ? null : firstLineOf(sample)).then((language) => {
      if (!alive) return;
      const { model, controls } = latest.current;
      if (!model || model.binary) return;
      const presentation = [new Compartment(), new Compartment(), new Compartment()] as const;
      const create = (i: PaneIndex) => {
        const pane = document.createElement("div");
        pane.className = styles.pane!;
        element.append(pane);
        const attached = i === 2 ? local : null;
        const staged = i === 1 ? index : null;
        return new EditorView({
          parent: pane,
          doc: attached?.text() ?? staged?.status.getState().text ?? model.docs[i],
          dispatchTransactions: attached?.dispatchTransactions,
          extensions: [
            staged?.extension() ?? [],
            staged ? embeddedEditorExtensions(path) : [],
            viewerBase({ readOnly: attached?.readOnly ?? !staged }),
            language ?? [],
            EditorView.contentAttributes.of({ "aria-label": labels[i] }),
            presentation[i].of([]),
            model.ranges ? diffRangeView : [],
            attached
              ? [
                  attached.extension,
                  diffSideExtensions(attached.context()),
                  documentTooltips,
                  embeddedEditorExtensions(path),
                  EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    clearTimeout(reportEdit);
                    reportEdit = setTimeout(() => latest.current.onLocalText?.(update.view.state.doc.toString()), 100);
                  }),
                ]
              : [],
          ],
        });
      };
      const editors = [create(0), create(1), create(2)] as const;
      views.current = { editors, presentation, local, index };
      present(views.current, model, controls);
      stopScroll = syncMergeScroll({ ours: editors[0], result: editors[1], theirs: editors[2] });
      if (local) latest.current.onLocalText?.(editors[2].state.doc.toString());
      latest.current.onEditors?.(editors);
    });
    return () => {
      alive = false;
      clearTimeout(reportEdit);
      stopScroll?.();
      latest.current.onEditors?.(null);
      views.current?.editors.forEach((view) => view.destroy());
      views.current = null;
      element.replaceChildren();
    };
  }, [labels, local, index, path, ready]);
  return (
    <div className={styles.root}>
      <div className={styles.labels}>
        {labels.map((label, i) => (
          <span key={i} title={label}>
            {label}
            {model?.texts[i] === null && <span className={styles.absent}> {tx("(does not exist)")}</span>}
          </span>
        ))}
      </div>
      {model?.binary ? (
        <div className={styles.status}>{tx("Binary content")}</div>
      ) : (
        <div className={styles.panes} ref={host} />
      )}
    </div>
  );
}
