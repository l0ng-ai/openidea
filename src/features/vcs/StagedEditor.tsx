import { useEffect, useRef, useState } from "react";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useStore } from "zustand";
import type { Pos } from "@/bindings";
import { activeEditor, embeddedEditorExtensions } from "@/editor/api";
import { executeAction, registerActions } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands, isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { Button, fileIconName, showContextMenu, type MenuItem } from "@/ui";
import {
  editorService,
  maybeEditorService,
  registerEditorKind,
  registerMenuGroup,
  useEditorShown,
  type EditorInput,
} from "@/workbench/contributions";
import { firstLineOf, languageFor, viewerBase } from "./cm";
import { openVcsDiff, withChain, type DiffData } from "./diffInput";
import { confirmDialog } from "./dialogs";
import { baseName, stripSlash } from "./model";
import { readWorkingText } from "./ops";
import { stagingAreaOn } from "./staging";
import { SHOW_THREE_SIDE_DIFF, stagingVersions } from "./stagingVersions";
import { repoOf, statusOf } from "./store";
import {
  emptyStagedStatus,
  ownedStagedDocument,
  stagedDocument,
  stagedDocumentLifecycle,
  type StagedDocument,
} from "./stagedDocument";
import styles from "./StagedEditor.module.css";

const KIND = "git-staged";
const LOCAL_ACTION = "vcs.showLocalVersion";
export const SHOW_STAGED_VERSION = "vcs.showStagedVersion";
const COMPARE_WITH_STAGED = "vcs.compareWithStagedVersion";
const COMPARE_WITH_LOCAL = "vcs.compareStagedWithLocal";
const COMPARE_WITH_HEAD = "vcs.compareStagedWithHead";
const COMPARE_THREE_VERSIONS = "vcs.compareThreeVersions";

type Comparison = "local" | "head" | "three";
const EDITOR_COMPARISONS = [
  { id: COMPARE_WITH_LOCAL, title: "Compare with Local Version", target: "local" },
  { id: COMPARE_WITH_HEAD, title: "Compare with HEAD", target: "head" },
  { id: COMPARE_THREE_VERSIONS, title: "Compare Three Versions", target: "three" },
] as const;

interface StagedInput {
  path: string;
  project: string;
  caret?: Pos;
}

function viewCaret(view?: EditorView): Pos | undefined {
  if (!view) return;
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number - 1, col: head - line.from };
}

/** Map a caret between the index and working text through their line changes. */
async function mapCaret(from: string, to: string, caret: Pos): Promise<Pos> {
  const hunks = await commands.vcsDiffHunks(from, to).catch(() => []);
  let delta = 0;
  for (const h of hunks) {
    if (caret.line < h.oldStart) break;
    if (caret.line < h.oldStart + h.oldLines) {
      return { line: h.start + Math.min(caret.line - h.oldStart, Math.max(0, h.lines - 1)), col: caret.col };
    }
    delta += h.lines - h.oldLines;
  }
  return { line: caret.line + delta, col: caret.col };
}

const lifecycle = stagedDocumentLifecycle();

function mountStagedView(doc: StagedDocument, parent: HTMLElement, caret?: Pos) {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    doc: doc.status.getState().text,
    extensions: [
      doc.extension(),
      viewerBase({ readOnly: false }),
      language.of([]),
      embeddedEditorExtensions(doc.path),
      EditorView.contentAttributes.of({ "aria-label": tx("Staged version editor") }),
    ],
  });
  let mounted = true;
  void doc.reload().then(async () => {
    if (!mounted) return;
    if (caret) {
      const line = view.state.doc.line(Math.min(caret.line + 1, view.state.doc.lines));
      view.dispatch({ selection: { anchor: line.from + Math.min(caret.col, line.length) }, scrollIntoView: true });
    }
    const support = await languageFor(doc.path, firstLineOf(doc.status.getState().text));
    if (support && mounted) view.dispatch({ effects: language.reconfigure(support) });
  });
  return () => {
    mounted = false;
    view.destroy();
  };
}

async function openLocal(doc: StagedDocument) {
  const caret = viewCaret(doc.activeView());
  const working = caret && (await readWorkingText(doc.path));
  const selection =
    caret && typeof working === "string" ? await mapCaret(doc.status.getState().text, working, caret) : undefined;
  if (useProject.getState().project?.root === doc.project)
    await editorService().openFile(doc.path, { focus: true, selection });
}

function compareStaged(doc: StagedDocument, target: Comparison): DiffData | undefined {
  const diff = stagingComparison(doc.path, target);
  if (!diff) return;
  const caret = viewCaret(doc.activeView());
  return { ...diff, ...caret, lineSide: target === "three" ? "middle" : target === "head" ? "right" : "left" };
}

function StagedEditor({ input }: { input: EditorInput }) {
  const data = input.data as StagedInput;
  const [doc] = useState(() => stagedDocument(data.path, input.key));
  const host = useRef<HTMLDivElement>(null);
  const { error, loading, closing } = useStore(doc?.status ?? emptyStagedStatus);
  const shown = useEditorShown();
  useEffect(
    () => (doc && host.current ? mountStagedView(doc, host.current, data.caret) : undefined),
    [doc, data.caret],
  );
  useEffect(() => {
    if (!shown || loading) return;
    const frame = requestAnimationFrame(() => {
      const view = host.current;
      if (view?.closest("[data-editor-focus]") === document.activeElement) {
        view?.querySelector<HTMLElement>(".cm-content")?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, shown]);
  const reload = async () => {
    if (!doc) return;
    if (
      doc.dirty &&
      !(await confirmDialog({
        title: "Reload Staged Version",
        message: tx("Discard your edits and reload the staged version?"),
        okLabel: "Reload",
      }))
    )
      return;
    await doc.reload(true);
  };
  return (
    <div className={styles.root}>
      <div className={styles.banner}>
        <span>{tx`This is the staged version of ${baseName(data.path)}`}</span>
        <Button variant="ghost" onClick={() => void executeAction(LOCAL_ACTION, input.key)}>
          Show Local Version
        </Button>
        <Button
          variant="ghost"
          aria-haspopup="menu"
          disabled={loading || closing}
          onClick={(event) => {
            const anchor = event.currentTarget.getBoundingClientRect();
            showContextMenu({ x: anchor.left, y: anchor.bottom }, stagedComparisonItems(input.key));
          }}
        >
          Compare
        </Button>
      </div>
      {error && (
        <div className={styles.banner} role="alert">
          <span>{error}</span>
          <Button variant="ghost" disabled={closing} onClick={() => void reload()}>
            Reload Staged Version
          </Button>
        </div>
      )}
      {loading && (
        <div className={styles.banner} role="status">
          {tx("Loading…")}
        </div>
      )}
      <div className={styles.editor} ref={host} />
    </div>
  );
}

function pathOf(arg: unknown) {
  return typeof arg === "string" ? arg : maybeEditorService()?.activePath();
}

function canShow(path: string | null | undefined): path is string {
  if (!path || !isTauri() || !stagingAreaOn() || !repoOf(path)) return false;
  const file = statusOf(path);
  return file?.staged !== "deleted" && file?.unstaged !== "untracked" && file?.unstaged !== "conflicted";
}

function stagingComparison(path: string | null | undefined, target: Comparison): DiffData | undefined {
  if (!canShow(path)) return;
  const file = statusOf(path);
  const versions = file && stagingVersions(file);
  if (!versions || versions.middle.type !== "rev") return;
  if (target === "head")
    return versions.left.type === "rev" ? { path, left: versions.left, right: versions.middle } : undefined;
  if (versions.right.type !== "worktree") return;
  if (target === "local") return { path, left: versions.middle, right: versions.right };
  return versions.left.type === "rev" ? versions : undefined;
}

function comparisonsForPaths(arg: unknown): DiffData[] {
  if (!stagingAreaOn() || !Array.isArray(arg)) return [];
  return [...new Set(arg)].flatMap((path) => {
    const file = typeof path === "string" ? statusOf(path) : undefined;
    const diff = file && stagingVersions(file);
    return diff ? [diff] : [];
  });
}

function activeStagedDocument(arg: unknown) {
  const input = maybeEditorService()?.activeInput?.();
  const key = typeof arg === "string" ? arg : input?.kind === KIND ? input.key : undefined;
  return key ? ownedStagedDocument(key) : undefined;
}

function localComparison(arg: unknown, target: Comparison): DiffData | undefined {
  const diff = stagingComparison(pathOf(arg), target);
  if (!diff) return;
  const editor = activeEditor();
  const caret = editor?.ctx.path === diff.path ? viewCaret(editor.view) : undefined;
  return { ...diff, ...caret };
}

function editorComparison(arg: unknown, target: Comparison): DiffData | undefined {
  const staged = activeStagedDocument(arg);
  return staged ? compareStaged(staged, target) : target === "three" ? localComparison(arg, target) : undefined;
}

function stagedComparisonItems(key: string): MenuItem[] {
  return EDITOR_COMPARISONS.map(({ id }) => ({ kind: "action", action: id, arg: key }));
}

async function showStaged(path: string) {
  const project = useProject.getState().project?.root;
  if (!project) return;
  const editor = activeEditor();
  const caret = editor?.ctx.path === path ? editor.view.state.selection.main.head : undefined;
  const input: StagedInput = { project, path: stripSlash(path) };
  if (editor && caret !== undefined) {
    const working = editor.view.state.doc;
    const line = working.lineAt(caret);
    const staged = await call(commands.vcsStagedText(input.path));
    if (staged)
      input.caret = await mapCaret(working.toString(), staged.text, { line: line.number - 1, col: caret - line.from });
  }
  if (useProject.getState().project?.root !== project) return;
  await editorService().openInput(
    { kind: KIND, key: `${KIND}:${project}\0${input.path}`, data: input },
    { focus: true },
  );
}

export function registerStagedEditor(): () => void {
  const disposers = [
    registerEditorKind({
      kind: KIND,
      component: StagedEditor,
      keepAlive: true,
      title: (input) => tx`Staged: ${baseName((input.data as StagedInput).path)}`,
      icon: (input) => fileIconName((input.data as StagedInput).path),
      document: lifecycle,
    }),
    registerActions([
      {
        id: SHOW_STAGED_VERSION,
        title: "Show Staged Version",
        category: "Git",
        when: "vcsAvailable",
        enabled: ({ arg }) => canShow(pathOf(arg)),
        run: ({ arg }) => {
          const path = pathOf(arg);
          if (canShow(path)) return showStaged(path);
        },
      },
      {
        id: LOCAL_ACTION,
        title: "Show Local Version",
        category: "Git",
        when: "vcsAvailable",
        enabled: ({ arg }) => !!activeStagedDocument(arg),
        run: ({ arg }) => {
          const doc = activeStagedDocument(arg);
          if (doc) return openLocal(doc);
        },
      },
      {
        id: COMPARE_WITH_STAGED,
        title: "Compare with Staged Version",
        category: "Git",
        when: "vcsAvailable",
        enabled: ({ arg }) => !!stagingComparison(pathOf(arg), "local"),
        run: ({ arg }) => {
          const diff = localComparison(arg, "local");
          if (diff) return openVcsDiff(diff);
        },
      },
      {
        id: SHOW_THREE_SIDE_DIFF,
        title: "Show Three-Side Diff",
        category: "Git",
        when: "vcsAvailable",
        enabled: ({ arg }) => comparisonsForPaths(arg).length > 0,
        run: ({ arg }) => {
          const diffs = comparisonsForPaths(arg);
          if (diffs.length) return openVcsDiff(withChain(diffs, 0));
        },
      },
      ...EDITOR_COMPARISONS.map(({ id, title, target }) => ({
        id,
        title,
        category: "Git",
        when: "vcsAvailable",
        enabled: ({ arg }: { arg?: unknown }) => !!editorComparison(arg, target),
        run: ({ arg }: { arg?: unknown }) => {
          const diff = editorComparison(arg, target);
          if (diff) return openVcsDiff(diff);
        },
      })),
    ]),
    registerMenuGroup({
      id: "vcs.stagedVersion",
      menus: ["editor", "editorTab", "projectView"],
      items: (_menu, { paths, dirs, input }) => {
        if (input?.kind === KIND) {
          return [{ kind: "action", action: LOCAL_ACTION, arg: input.key }, ...stagedComparisonItems(input.key)];
        }
        const path = paths[0];
        if (paths.length !== 1 || dirs?.[0] || !canShow(path)) return [];
        return [
          { kind: "action", action: SHOW_STAGED_VERSION, arg: path },
          ...(stagingComparison(path, "local")
            ? [{ kind: "action" as const, action: COMPARE_WITH_STAGED, arg: path }]
            : []),
          ...(stagingComparison(path, "three")
            ? [{ kind: "action" as const, action: COMPARE_THREE_VERSIONS, arg: path }]
            : []),
        ];
      },
    }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}
