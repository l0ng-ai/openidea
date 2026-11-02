/** Three-pane merge editor: Yours | Result | Theirs, after IntelliJ's merge tool. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Transaction, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undoDepth } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import type { MergeSides } from "@/bindings";
import { embeddedEditorExtensions } from "@/editor/api";
import { setContext } from "@/platform/context";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, Spinner, T } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { blameSlot } from "./blame";
import { languageFor, viewerBase } from "./cm";
import { confirmDialog } from "./dialogs";
import { focusedDiffNavigator, setFocusedDiffNavigator, type DiffNavigator } from "./diffNavigator";
import { syncMergeScroll } from "./mergeScroll";
import { mergeTitles } from "./conflicts";
import {
  mergeChanged,
  mergeTheme,
  resultControls,
  resultMarks,
  sideControls,
  syncSide,
  type MergeControls,
} from "./mergeGutters";
import { showCompareMenu, showResultMenu, showSettingsMenu, showSideMenu } from "./mergeMenus";
import {
  applyNonConflicting,
  applyTo,
  mergeField,
  mergeHistory,
  startMerge,
  summarize,
  unresolved,
  type MergeSide,
  type MergeSummary,
} from "./mergeModel";
import { MergeFooter, MergeToolbar } from "./MergeToolbar";
import { baseName } from "./model";
import { errorMessage, runOp, writeFileText } from "./ops";
import { refreshNow } from "./store";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";
export { MERGE_KIND, mergeInput, type MergeData } from "./mergeKind";

const NOTHING_LEFT: MergeSummary = {
  pending: 0,
  conflicts: 0,
  left: false,
  all: false,
  right: false,
  simple: false,
  revert: false,
};

// IntelliJ's "Automatically apply non-conflicting changes" (Tools | Diff & Merge); off by default.
const AUTO_APPLY_KEY = "openidea.merge.autoApplyNonConflicting";
const readAutoApply = () => {
  try {
    return localStorage.getItem(AUTO_APPLY_KEY) === "true";
  } catch {
    return false;
  }
};
const writeAutoApply = (on: boolean) => {
  try {
    localStorage.setItem(AUTO_APPLY_KEY, String(on));
  } catch {
    // The choice then lasts only until the editor closes.
  }
};

export function MergeEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as MergeData;
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    sides: MergeSides;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [summary, setSummary] = useState<MergeSummary>(NOTHING_LEFT);
  const [autoApply, setAutoApply] = useState(readAutoApply);
  const [resolved, setResolved] = useState(false);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const oursView = useRef<EditorView | null>(null);
  const theirsView = useRef<EditorView | null>(null);
  const autoApplyRef = useRef(autoApply);
  useEffect(() => {
    autoApplyRef.current = autoApply;
  }, [autoApply]);
  const txt = useTxTemplate();
  const titles = mergeTitles(state?.sides);

  const load = useCallback(async () => {
    try {
      const v = await call(commands.vcsConflictVersions(path));
      setState({ ours: v.ours ?? "", theirs: v.theirs ?? "", base: v.base, sides: v.sides });
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
    // Like IntelliJ, the result starts as the base, with every change waiting to be decided.
    const start = startMerge(state.ours, state.base ?? "", state.theirs);
    const run = (spec: TransactionSpec | null) => spec && result.dispatch(spec);
    const controls: MergeControls = {
      accept: (index, side, resolve) => run(applyTo(result.state, [index], { type: "accept", side, resolve })),
      ignore: (index, side, resolve) =>
        run(applyTo(result.state, [index], { type: "ignore", side: resolve ? null : side })),
      resolveAutomatically: (index) => run(applyTo(result.state, [index], { type: "auto", side: "base" })),
    };
    const side = (which: MergeSide): Extension[] => [
      viewerBase({ readOnly: true }),
      lang,
      blameSlot(),
      state.base !== null ? unifiedMergeView({ original: state.base, mergeControls: false, gutter: true }) : [],
      sideControls(which, controls),
      mergeTheme,
    ];
    const ours = new EditorView({ doc: state.ours, parent: oursRef.current, extensions: side("left") });
    const theirs = new EditorView({ doc: state.theirs, parent: theirsRef.current, extensions: side("right") });
    const result: EditorView = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: false }),
        history(),
        keymap.of(historyKeymap),
        mergeField.init(() => start.changes),
        mergeHistory,
        embeddedEditorExtensions(path),
        lang,
        resultMarks,
        resultControls(controls),
        mergeTheme,
        EditorView.updateListener.of((u) => {
          if (!mergeChanged(u)) return;
          const changes = u.state.field(mergeField);
          ours.dispatch({ effects: syncSide.of(changes) });
          theirs.dispatch({ effects: syncSide.of(changes) });
          setSummary(summarize(u.state));
        }),
      ],
    });
    resultView.current = result;
    oursView.current = ours;
    theirsView.current = theirs;
    ours.dispatch({ effects: syncSide.of(start.changes) });
    theirs.dispatch({ effects: syncSide.of(start.changes) });
    setSummary(summarize(result.state));
    if (autoApplyRef.current) {
      const spec = applyNonConflicting(result.state, "base");
      // The starting point, not a step to undo.
      if (spec) result.dispatch({ ...spec, annotations: Transaction.addToHistory.of(false) });
    }
    // Scroll the three panes together, lined up through their changes.
    const stopSync = syncMergeScroll({ ours, result, theirs });
    return () => {
      stopSync();
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
      oursView.current = null;
      theirsView.current = null;
    };
  }, [state, lang, path]);

  /** Puts the caret at a change and brings it into view. */
  const moveTo = (view: EditorView, at: number) =>
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const open = unresolved(v.state);
    if (!open.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (open.find((c) => c.from > head) ?? open[0]!)
        : ([...open].reverse().find((c) => c.from < head) ?? open[open.length - 1]!);
    moveTo(v, target.from);
    v.focus();
  };

  /** Runs a command on the result; `reveal` then moves to what is left to decide. */
  const command = (make: (s: EditorState) => TransactionSpec | null, reveal = false) => {
    const v = resultView.current;
    const spec = v && make(v.state);
    if (!v || !spec) return;
    v.dispatch(spec);
    const first = reveal ? unresolved(v.state)[0] : undefined;
    if (first) moveTo(v, first.from);
  };

  /** Saves `text` as the resolved file and stages it; like IDEA, that closes the merge editor. */
  const writeResolved = async (text: string) => {
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
      await editorService().closeInput?.(input.key);
    }
  };

  const apply = async () => {
    const v = resultView.current;
    if (!v) return;
    const remaining = unresolved(v.state).length;
    if (
      remaining > 0 &&
      !(await confirmDialog({
        title: "Unresolved Changes",
        message:
          remaining === 1
            ? tx`${remaining} change is unresolved and keeps the base text. Save and mark the file as resolved anyway?`
            : tx`${remaining} changes are unresolved and keep the base text. Save and mark the file as resolved anyway?`,
        okLabel: "Mark Resolved",
      }))
    )
      return;
    await writeResolved(v.state.doc.toString());
  };

  /** Whether the user decided or edited anything: what Accept and Cancel ask about. */
  const modified = () => {
    const v = resultView.current;
    return !!v && undoDepth(v.state) > 0;
  };

  /** Accept Yours / Accept Theirs: that version as it is, whatever was done in the result. */
  const acceptSide = async (side: MergeSide) => {
    if (!state) return;
    if (
      modified() &&
      !(await confirmDialog({
        title: side === "left" ? "Accept Yours" : "Accept Theirs",
        message: "The result was changed. Discard the changes and take this version as it is?",
        okLabel: "Discard Changes",
        danger: true,
      }))
    )
      return;
    await writeResolved(side === "left" ? state.ours : state.theirs);
  };

  const cancel = async () => {
    if (
      modified() &&
      !(await confirmDialog({
        title: "Cancel Merge",
        message: "Exit without applying the changes made in the result?",
        okLabel: "Exit",
        danger: true,
      }))
    )
      return;
    await editorService().closeInput?.(input.key);
  };

  // Next / Previous Difference (F7 / Shift+F7 by default) jump between changes through
  // the keymap, as in the diff viewer.
  // `goto` reads only refs, so the first render's one stays valid.
  const [nav] = useState<DiffNavigator>(() => ({
    next: () => goto(1),
    prev: () => goto(-1),
    jumpToSource: () => void editorService().openFile(path, { focus: true }),
    applyChange: () => false,
    file: () => {},
    showSettings: () => {},
  }));
  useEffect(
    () => () => {
      if (focusedDiffNavigator() === nav) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
    [nav],
  );

  const setAutoApplyNonConflicting = (on: boolean) => {
    setAutoApply(on);
    writeAutoApply(on);
    if (on) command((s) => applyNonConflicting(s, "base"), true);
  };

  const compare = (e: React.MouseEvent) => {
    const v = resultView.current;
    if (!state || !v) return;
    showCompareMenu(e, path, {
      yours: { text: state.ours, label: txt(titles.yours) },
      base: { text: state.base ?? "", label: tx("Base") },
      result: { text: v.state.doc.toString(), label: tx("Result") },
      theirs: { text: state.theirs, label: txt(titles.theirs) },
    });
  };

  // Each side is annotated with Git Blame on the branch it belongs to.
  const otherRev = state?.sides.commit ?? "HEAD";
  const sidePane = (e: React.MouseEvent, which: MergeSide) => {
    const view = (which === "left" ? oursView : theirsView).current;
    const result = resultView.current;
    if (!view || !result || !state) return;
    // Yours is the current branch, except in a rebase, where it is the commit being replayed.
    const isHead = which === "left" ? !state.sides.reversed : state.sides.reversed;
    const revision = isHead ? "HEAD" : otherRev;
    showSideMenu(
      e,
      { which, view, path, text: which === "left" ? state.ours : state.theirs, revision },
      result,
      command,
    );
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
    <div
      className={styles.root}
      onFocusCapture={() => {
        setFocusedDiffNavigator(nav);
        setContext("diffEditorFocus", true);
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedDiffNavigator() === nav) {
          setFocusedDiffNavigator(null);
          setContext("diffEditorFocus", false);
        }
      }}
    >
      <MergeToolbar
        summary={summary}
        goto={goto}
        run={command}
        onCompare={compare}
        onReload={() => void load()}
        onSettings={(e) => showSettingsMenu(e, autoApply, setAutoApplyNonConflicting)}
      />
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
        <div
          ref={oursRef}
          className={styles.pane}
          aria-label={tx("Your version")}
          role="region"
          onContextMenu={(e) => sidePane(e, "left")}
        />
        <div
          ref={resultRef}
          className={styles.pane}
          aria-label={tx("Result")}
          role="region"
          onContextMenu={(e) => resultView.current && showResultMenu(e, resultView.current, command)}
        />
        <div
          ref={theirsRef}
          className={styles.pane}
          aria-label={tx("Their version")}
          role="region"
          onContextMenu={(e) => sidePane(e, "right")}
        />
      </div>
      <MergeFooter
        onAccept={(side) => void acceptSide(side)}
        onCancel={() => void cancel()}
        onApply={() => void apply()}
      />
    </div>
  );
}
