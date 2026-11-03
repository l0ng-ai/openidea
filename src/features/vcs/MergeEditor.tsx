/** Three-pane merge editor: Yours | Result | Theirs, after IntelliJ's merge tool. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Transaction, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { history, historyKeymap, undoDepth } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import type { MergeSides } from "@/bindings";
import { embeddedEditorExtensions } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { copyText } from "@/ui/selectableText";
import { Button, Spinner, T } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { blameSlot, toggleAnnotations } from "./blame";
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
import { COMPARISONS, showCompareMenu, showResultMenu, showSettingsMenu, showSideMenu } from "./mergeMenus";
import { openDiff } from "./diffInput";
import {
  clearFocusedMergeEditor,
  refreshMergeActions,
  setFocusedMergeEditor,
  type MergeActionHost,
  type MergeCommand,
} from "./mergeActions";
import {
  applyNonConflicting,
  applyTo,
  canApply,
  changesIn,
  changesInSide,
  resolveSimple,
  revertResolved,
  mergeField,
  mergeHistory,
  startMerge,
  summarize,
  unresolved,
  type MergeAction,
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
    deleted: Record<MergeSide, boolean>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [summary, setSummary] = useState<MergeSummary>(NOTHING_LEFT);
  const [autoApply, setAutoApply] = useState(readAutoApply);
  const [resolved, setResolved] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<MergeSide | "result">("result");
  const [actionHost] = useState<MergeActionHost>(() => ({
    enabled: () => false,
    run: () => {},
    autoApply: () => false,
  }));
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
      if ([v.base, v.ours, v.theirs].some((text) => text?.includes("\0"))) {
        throw new Error(tx("Binary files cannot be resolved in the merge editor."));
      }
      setState({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        sides: v.sides,
        deleted: { left: v.ours === null, right: v.theirs === null },
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
    // Like IntelliJ, the result starts as the base, with every change waiting to be decided.
    const start = startMerge(state.ours, state.base ?? "", state.theirs);
    const change = (index: number, action: MergeAction) => {
      setFocusedMergeEditor(actionHost);
      void executeAction("merge.change", { indexes: [index], action });
    };
    const controls: MergeControls = {
      accept: (index, side, resolve) => change(index, { type: "accept", side, resolve }),
      ignore: (index, side, resolve) => change(index, { type: "ignore", side: resolve ? null : side }),
      resolveAutomatically: (index) => change(index, { type: "auto", side: "base" }),
    };
    const side = (which: MergeSide): Extension[] => [
      viewerBase({ readOnly: true }),
      lang,
      blameSlot(),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) refreshMergeActions(actionHost);
      }),
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
          if (u.selectionSet || mergeChanged(u)) refreshMergeActions(actionHost);
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
  }, [state, lang, path, actionHost]);

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
  const writeResolved = async (text: string | null) => {
    const ok = await runOp(
      `Resolve ${baseName(path)}`,
      async () => {
        if (text === null) await call(commands.fsDelete(path));
        else await writeFileText(path, text, { save: true, exact: true });
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
    const separator = (state?.base ?? state?.ours ?? state?.theirs ?? "").includes("\r\n") ? "\r\n" : "\n";
    await writeResolved(v.state.doc.sliceString(0, undefined, separator));
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
    await writeResolved(state.deleted[side] ? null : side === "left" ? state.ours : state.theirs);
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
    showSettings: () => void actionHost.run("settings"),
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

  const activePane = () => {
    const which = paneRef.current;
    return (which === "left" ? oursView : which === "right" ? theirsView : resultView).current;
  };

  const selectionDecision = (id: MergeCommand) => {
    const view = activePane();
    const result = resultView.current;
    if (!view || !result) return null;
    const { from, to } = view.state.selection.main;
    const side = paneRef.current;
    const indexes =
      side === "result"
        ? changesIn(result.state, from, to)
        : changesInSide(result.state, side, view.state.doc, from, to);
    let action: MergeAction;
    if (id === "resolveAutomatically") action = { type: "auto", side: "base" };
    else if (id === "ignore") action = { type: "ignore", side: side === "result" ? null : side };
    else if (id === "resolveUsingYours" || id === "resolveUsingTheirs")
      action = { type: "accept", side: id === "resolveUsingYours" ? "left" : "right", resolve: true };
    else if (id === "accept" && side !== "result") action = { type: "accept", side, resolve: false };
    else return null;
    return { indexes, action };
  };

  const enabled = (id: MergeCommand) => {
    if (id === "reload" || id === "cancel") return !resolved;
    const v = resultView.current;
    if (!v || error || resolved) return false;
    const available = summarize(v.state);
    switch (id) {
      case "applyLeft":
        return available.left;
      case "applyAll":
        return available.all;
      case "applyRight":
        return available.right;
      case "resolveSimple":
        return available.simple;
      case "revert":
        return available.revert;
      case "accept":
      case "resolveUsingYours":
      case "resolveUsingTheirs":
      case "ignore":
      case "resolveAutomatically": {
        const decision = selectionDecision(id);
        return !!decision?.indexes.some((i) => canApply(v.state.doc, v.state.field(mergeField)[i]!, decision.action));
      }
      case "annotate":
        return paneRef.current !== "result";
      case "cut":
        return paneRef.current === "result" && !v.state.selection.main.empty;
      case "copy":
        return !!activePane() && !activePane()!.state.selection.main.empty;
      case "paste":
        return paneRef.current === "result";
      default:
        return true;
    }
  };

  const menuPosition = (name: "compare" | "settings") => {
    const button = rootRef.current?.querySelector(`[data-merge-menu="${name}"]`);
    const rect = (button ?? rootRef.current)?.getBoundingClientRect();
    return { clientX: rect?.left ?? 0, clientY: rect?.bottom ?? 0 };
  };

  const runAction = async (id: MergeCommand, arg?: unknown) => {
    switch (id) {
      case "applyLeft":
        return command((s) => applyNonConflicting(s, "left"), true);
      case "applyAll":
        return command((s) => applyNonConflicting(s, "base"), true);
      case "applyRight":
        return command((s) => applyNonConflicting(s, "right"), true);
      case "resolveSimple":
        return command(resolveSimple, true);
      case "revert":
        return command(revertResolved, true);
      case "acceptYours":
        return acceptSide("left");
      case "acceptTheirs":
        return acceptSide("right");
      case "apply":
        return apply();
      case "cancel":
        return cancel();
      case "reload":
        return load();
      case "compare":
        return showCompareMenu(menuPosition("compare"));
      case "settings":
        return showSettingsMenu(menuPosition("settings"));
      case "autoApply":
        return setAutoApplyNonConflicting(!autoApply);
      case "accept":
      case "resolveUsingYours":
      case "resolveUsingTheirs":
      case "ignore":
      case "resolveAutomatically": {
        const decision = selectionDecision(id);
        if (decision) command((s) => applyTo(s, decision.indexes, decision.action));
        return;
      }
      case "change": {
        const change = arg as { indexes: number[]; action: MergeAction } | undefined;
        if (change) command((s) => applyTo(s, change.indexes, change.action));
        return;
      }
      case "annotate": {
        const which = paneRef.current;
        const view = activePane();
        if (!state || !view || which === "result") return;
        const isHead = which === "left" ? !state.sides.reversed : state.sides.reversed;
        await toggleAnnotations(
          view,
          path,
          which === "left" ? state.ours : state.theirs,
          isHead ? "HEAD" : (state.sides.commit ?? "HEAD"),
        );
        return;
      }
      case "cut":
      case "copy":
      case "paste":
      case "selectAll": {
        const view = activePane();
        if (!view) return;
        const { from, to } = view.state.selection.main;
        if (id === "selectAll") view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        else if (id === "paste") {
          const text = await navigator.clipboard?.readText().catch(() => undefined);
          if (text !== undefined) view.dispatch({ ...view.state.replaceSelection(text), userEvent: "input.paste" });
        } else {
          await copyText(view.state.sliceDoc(from, to));
          if (id === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
        }
        return;
      }
      default: {
        const v = resultView.current;
        if (!state || !v || !(id in COMPARISONS)) return;
        const versions = {
          yours: { text: state.ours, label: txt(titles.yours) },
          base: { text: state.base ?? "", label: tx("Base") },
          result: { text: v.state.doc.toString(), label: tx("Result") },
          theirs: { text: state.theirs, label: txt(titles.theirs) },
        };
        const [a, b] = COMPARISONS[id as keyof typeof COMPARISONS];
        await openDiff({ path, left: { type: "text", ...versions[a] }, right: { type: "text", ...versions[b] } });
      }
    }
  };

  useEffect(() => {
    Object.assign(actionHost, { enabled, run: runAction, autoApply: () => autoApply });
    refreshMergeActions(actionHost);
  });

  useEffect(() => {
    // Popup focus belongs to the editor that opened it; a real focus change releases it.
    const onFocus = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (!rootRef.current?.contains(target) && !target?.closest("[data-popup], [role=dialog]"))
        clearFocusedMergeEditor(actionHost);
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      clearFocusedMergeEditor(actionHost);
    };
  }, [actionHost]);

  const focusProps = {
    onFocusCapture: (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.target as Node;
      if (oursRef.current?.contains(target)) paneRef.current = "left";
      else if (theirsRef.current?.contains(target)) paneRef.current = "right";
      else if (resultRef.current?.contains(target)) paneRef.current = "result";
      setFocusedMergeEditor(actionHost);
      setFocusedDiffNavigator(nav);
      setContext("diffEditorFocus", true);
    },
    onBlurCapture: (e: React.FocusEvent<HTMLDivElement>) => {
      const target = e.relatedTarget as Element | null;
      if (e.currentTarget.contains(target) || target?.closest("[data-popup], [role=dialog]")) return;
      clearFocusedMergeEditor(actionHost);
      if (focusedDiffNavigator() === nav) {
        setFocusedDiffNavigator(null);
        setContext("diffEditorFocus", false);
      }
    },
  };

  if (error)
    return (
      <div ref={rootRef} className={styles.message} {...focusProps}>
        {error}
        <Button onClick={() => void executeAction("merge.reload")}>
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
    <div ref={rootRef} className={styles.root} {...focusProps}>
      <MergeToolbar summary={summary} />
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
          onContextMenu={(e) => oursView.current && showSideMenu(e, oursView.current, "left")}
        />
        <div
          ref={resultRef}
          className={styles.pane}
          aria-label={tx("Result")}
          role="region"
          onContextMenu={(e) => resultView.current && showResultMenu(e, resultView.current)}
        />
        <div
          ref={theirsRef}
          className={styles.pane}
          aria-label={tx("Their version")}
          role="region"
          onContextMenu={(e) => theirsView.current && showSideMenu(e, theirsView.current, "right")}
        />
      </div>
      <MergeFooter />
    </div>
  );
}
