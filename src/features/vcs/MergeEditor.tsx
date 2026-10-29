/** Three-pane merge conflict editor: Yours | Result | Theirs. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { MergeSides } from "@/bindings";
import { embeddedEditorExtensions } from "@/editor/api";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, IconButton, Spinner, T } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { languageFor, viewerBase } from "./cm";
import { confirmDialog } from "./dialogs";
import { initialResult, mergeTitles, resolutionText, type Resolution, type ResultConflict } from "./conflicts";
import { baseName } from "./model";
import { errorMessage, readWorkingText, runOp, writeFileText } from "./ops";
import { refreshNow } from "./store";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";
export { MERGE_KIND, mergeInput, type MergeData } from "./mergeKind";

/** Drops the conflict at an index once a resolution replaced its text. */
const resolvedConflict = StateEffect.define<number>();

function resolveConflict(view: EditorView, index: number, how: Resolution) {
  const c = view.state.field(conflictField).conflicts[index];
  if (!c) return;
  view.dispatch({
    changes: { from: c.from, to: c.to, insert: resolutionText(c, how) },
    effects: resolvedConflict.of(index),
    userEvent: "input.resolve",
  });
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly hasBase: boolean,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-conflict-actions";
    const add = (label: string, how: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      // Keep the caret / focus in the editor; resolve on click (mouse or keyboard).
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = (e) => {
        e.preventDefault();
        resolveConflict(view, this.index, how);
      };
      el.appendChild(b);
    };
    const title = document.createElement("span");
    title.textContent = `Conflict ${this.index + 1}`;
    el.appendChild(title);
    add("Accept Yours", "ours");
    add("Accept Theirs", "theirs");
    add("Accept Both", "both");
    if (this.hasBase) add("Use Base", "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const conflictLine = Decoration.line({ class: "cm-conflict-marker" });

function decorate(state: EditorState, conflicts: readonly ResultConflict[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  conflicts.forEach((c, i) => {
    b.add(c.from, c.from, Decoration.widget({ widget: new ActionsWidget(i, c.base !== null), block: true, side: -1 }));
    if (c.to <= c.from) return;
    const endLine = doc.lineAt(c.to - 1).number;
    for (let n = doc.lineAt(c.from).number; n <= endLine; n++) b.add(doc.line(n).from, doc.line(n).from, conflictLine);
  });
  return b.finish();
}

/**
 * The result's unresolved conflicts, tracked as ranges holding the base text (no
 * markers), as IDEA's merge dialog shows them. Typing at a conflict's edges stays in it.
 */
const conflictField = StateField.define<{ conflicts: ResultConflict[]; deco: DecorationSet }>({
  create: () => ({ conflicts: [], deco: Decoration.none }),
  update(v, tr) {
    const done = new Set(tr.effects.filter((e) => e.is(resolvedConflict)).map((e) => e.value as number));
    let conflicts = v.conflicts.filter((_, i) => !done.has(i));
    if (tr.docChanged)
      conflicts = conflicts.map((c) => ({ ...c, from: tr.changes.mapPos(c.from, -1), to: tr.changes.mapPos(c.to, 1) }));
    if (!tr.docChanged && !done.size) return v;
    return { conflicts, deco: decorate(tr.state, conflicts) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const resultTheme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    backgroundColor: "color-mix(in srgb, var(--vcs-conflict) 14%, transparent)",
    color: "var(--fg-subtle)",
  },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    color: "var(--vcs-conflict)",
    background: "var(--bg-elev)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-conflict-actions button": {
    padding: "0 6px",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "var(--bg-control)",
    font: "inherit",
    lineHeight: "18px",
  },
  ".cm-conflict-actions button:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
});

export function MergeEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as MergeData;
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    working: string;
    merged: string | null;
    sides: MergeSides;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [left, setLeft] = useState(0);
  const [resolved, setResolved] = useState(false);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const txt = useTxTemplate();
  const titles = mergeTitles(state?.sides);

  const load = useCallback(async () => {
    try {
      const [v, working] = await Promise.all([call(commands.vcsConflictVersions(path)), readWorkingText(path)]);
      setState({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        working: working ?? "",
        merged: v.merged,
        sides: v.sides,
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    let alive = true;
    void languageFor(path).then((l) => alive && setLang(() => l ?? []));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!state || lang === null || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    const side = () => [
      viewerBase({ readOnly: true }),
      lang,
      state.base !== null ? unifiedMergeView({ original: state.base, mergeControls: false, gutter: true }) : [],
    ];
    const ours = new EditorView({ doc: state.ours, parent: oursRef.current, extensions: side() });
    const theirs = new EditorView({ doc: state.theirs, parent: theirsRef.current, extensions: side() });
    // Like IDEA, start from the three-way merge (non-conflicting changes applied, conflicts
    // showing the base) rather than the marker-laden working copy.
    const start =
      state.merged !== null ? initialResult(state.merged) : initialResult(state.working, state.sides.reversed);
    const result = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: false }),
        history(),
        keymap.of(historyKeymap),
        embeddedEditorExtensions(path),
        lang,
        conflictField.init((s) => ({ conflicts: start.conflicts, deco: decorate(s, start.conflicts) })),
        resultTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setLeft(u.state.field(conflictField).conflicts.length);
        }),
      ],
    });
    resultView.current = result;
    setLeft(result.state.field(conflictField).conflicts.length);
    return () => {
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
    };
  }, [state, lang, path]);

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const blocks = v.state.field(conflictField).conflicts;
    if (!blocks.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
        : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
    v.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    v.focus();
  };

  const acceptAll = (how: Resolution) => {
    const v = resultView.current;
    if (!v) return;
    const conflicts = v.state.field(conflictField).conflicts;
    v.dispatch({
      changes: conflicts.map((c) => ({ from: c.from, to: c.to, insert: resolutionText(c, how) })),
      effects: conflicts.map((_, i) => resolvedConflict.of(i)),
      userEvent: "input.resolve",
    });
  };

  const apply = async () => {
    const v = resultView.current;
    if (!v) return;
    const remaining = v.state.field(conflictField).conflicts.length;
    if (
      remaining > 0 &&
      !(await confirmDialog({
        title: "Unresolved Conflicts",
        message:
          remaining === 1
            ? tx`${remaining} conflict is unresolved and keeps the base text. Save and mark the file as resolved anyway?`
            : tx`${remaining} conflicts are unresolved and keep the base text. Save and mark the file as resolved anyway?`,
        okLabel: "Mark Resolved",
      }))
    )
      return;
    const text = v.state.doc.toString();
    const ok = await runOp(
      `Resolve ${baseName(path)}`,
      async () => {
        await writeFileText(path, text, { save: true });
        await call(commands.vcsStage([path]));
        return true;
      },
      { success: `${baseName(path)}: conflicts resolved` },
    );
    if (ok) {
      setResolved(true);
      await refreshNow();
      // Like IDEA, applying the result closes the merge editor.
      await editorService().closeInput?.(input.key);
    }
  };

  if (error)
    return (
      <div className={styles.message}>
        {error}
        <Button onClick={() => void load()}>
          <T>Retry</T>
        </Button>
      </div>
    );
  if (resolved)
    return (
      <div className={styles.message}>
        {tx`${baseName(path)} has been resolved and staged.`}
        <Button onClick={() => void editorService().openFile(path, { focus: true })}>
          <T>Open File</T>
        </Button>
      </div>
    );

  return (
    <div className={styles.root}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
        <IconButton icon="arrow-up" title="Previous Conflict" size="small" onClick={() => goto(-1)} />
        <IconButton icon="arrow-down" title="Next Conflict" size="small" onClick={() => goto(1)} />
        <span className={styles.sep} />
        <Button size="small" onClick={() => acceptAll("ours")}>
          <T>Accept All Yours</T>
        </Button>
        <Button size="small" onClick={() => acceptAll("theirs")}>
          <T>Accept All Theirs</T>
        </Button>
        <IconButton icon="refresh" title="Reload from Disk" size="small" onClick={() => void load()} />
        <span className={clsx(styles.status, !left && styles.statusDone)}>
          {left === 1 ? tx`${left} conflict left` : left ? tx`${left} conflicts left` : tx("All conflicts resolved")}
        </span>
        <Button size="small" variant="primary" onClick={() => void apply()}>
          <T>Apply</T>
        </Button>
      </div>
      <div className={styles.labels}>
        <span>{txt(titles.yours)}</span>
        <span>
          <T>Result</T>
        </span>
        <span>{txt(titles.theirs)}</span>
      </div>
      {!state || lang === null ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div className={styles.panes} hidden={!state || lang === null}>
        <div ref={oursRef} className={styles.pane} aria-label={tx("Your version")} role="region" />
        <div ref={resultRef} className={styles.pane} aria-label={tx("Result")} role="region" />
        <div ref={theirsRef} className={styles.pane} aria-label={tx("Their version")} role="region" />
      </div>
    </div>
  );
}
