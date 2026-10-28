/**
 * Compare entry points (IDEA's Compare With…, Compare Files, Compare with
 * Clipboard) and the diff viewer's own actions (F7 / ⇧F7, F4).
 */
import { activeEditor } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { isTauri } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { focusedDiffNavigator } from "./diffNavigator";
import { openDiff, type DiffData } from "./diffInput";
import { baseName } from "./model";
import { tx } from "@/platform/i18n";

function argPath(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "path" in arg && typeof (arg as { path: unknown }).path === "string")
    return (arg as { path: string }).path;
  return undefined;
}

function argPaths(arg: unknown): string[] {
  if (Array.isArray(arg)) return arg.filter((x): x is string => typeof x === "string");
  if (arg && typeof arg === "object" && "paths" in arg && Array.isArray((arg as { paths: unknown }).paths))
    return ((arg as { paths: unknown[] }).paths ?? []).filter((x): x is string => typeof x === "string");
  const p = argPath(arg);
  return p ? [p] : [];
}

/** Project-relative path for labels. */
export function displayPath(path: string, root = useProject.getState().project?.root ?? null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Diff of two files on disk; both sides are live, editable documents. */
export function compareFilesData(leftPath: string, rightPath: string): DiffData {
  return {
    path: rightPath,
    left: { type: "file", path: leftPath, label: displayPath(leftPath) },
    right: { type: "worktree", label: displayPath(rightPath) },
  };
}

/** Clipboard ↔ the file (editable) or ↔ the editor selection. */
export function clipboardDiffData(path: string, clipboard: string, selection: string | null): DiffData {
  return {
    path,
    title: selection ? tx`Clipboard ↔ ${baseName(path)} (selection)` : tx`Clipboard ↔ ${baseName(path)}`,
    left: { type: "text", text: clipboard, label: "Clipboard" },
    right: selection
      ? { type: "text", text: selection, label: "Selection" }
      : { type: "worktree", label: displayPath(path) },
  };
}

export interface TextsArg {
  path: string;
  title?: string;
  left: { text: string; label: string };
  right: { text: string; label: string };
  line?: number;
}

export function parseTextsArg(arg: unknown): TextsArg | null {
  if (!arg || typeof arg !== "object") return null;
  const a = arg as Record<string, unknown>;
  const side = (v: unknown) =>
    v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string"
      ? { text: (v as { text: string }).text, label: String((v as { label?: unknown }).label ?? "") }
      : null;
  const left = side(a.left);
  const right = side(a.right);
  if (typeof a.path !== "string" || !left || !right) return null;
  return {
    path: a.path,
    title: typeof a.title === "string" ? a.title : undefined,
    left,
    right,
    line: typeof a.line === "number" ? a.line : undefined,
  };
}

function info(title: string) {
  notifications().notify({ group: "vcs", level: "info", title });
}

async function pickFile(near: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = near.slice(0, near.lastIndexOf("/")) || undefined;
  const picked = await open({ multiple: false, directory: false, title: "Compare With", defaultPath: dir });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

const contextPath = (arg: unknown) => argPath(arg) ?? maybeEditorService()?.activePath() ?? undefined;

export function registerCompareActions(): () => void {
  return registerActions([
    {
      id: "vcs.openDiff",
      title: "Open Diff",
      description: "Opens the diff viewer for a `DiffData` argument (e.g. a pull request file).",
      category: "Diff",
      icon: "diff",
      when: "projectOpen",
      hidden: true,
      run: ({ arg }) => {
        const data = arg as DiffData | undefined;
        if (data && typeof data.path === "string" && data.left && data.right) return openDiff(data);
      },
    },
    {
      id: "diff.nextDifference",
      title: "Next Difference",
      category: "Diff",
      icon: "arrow-down",
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.next(),
    },
    {
      id: "diff.prevDifference",
      title: "Previous Difference",
      category: "Diff",
      icon: "arrow-up",
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.prev(),
    },
    {
      id: "diff.showSettings",
      title: "Diff Settings",
      category: "Diff",
      icon: "settings",
      keywords: ["ignore whitespace", "highlighting", "side-by-side", "unified"],
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.showSettings(),
    },
    {
      id: "diff.nextFile",
      title: "Compare Next File",
      category: "Diff",
      icon: "arrow-right",
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.file(1),
    },
    {
      id: "diff.prevFile",
      title: "Compare Previous File",
      category: "Diff",
      icon: "arrow-left",
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.file(-1),
    },
    {
      id: "diff.applyLeftSide",
      title: "Accept Left Side",
      description: "Copies the change at the caret from the left side to the right one",
      category: "Diff",
      icon: "arrow-right",
      when: "diffEditorFocus",
      run: () => void focusedDiffNavigator()?.applyChange("a"),
    },
    {
      id: "diff.applyRightSide",
      title: "Accept Right Side",
      description: "Copies the change at the caret from the right side to the left one",
      category: "Diff",
      icon: "arrow-left",
      when: "diffEditorFocus",
      run: () => void focusedDiffNavigator()?.applyChange("b"),
    },
    {
      id: "diff.jumpToSource",
      title: "Jump to Source",
      category: "Diff",
      icon: "external-link",
      when: "diffEditorFocus",
      run: () => focusedDiffNavigator()?.jumpToSource(),
    },
    {
      id: "diff.compareWith",
      title: "Compare With…",
      category: "Diff",
      icon: "diff",
      when: "projectOpen",
      keywords: ["diff", "compare files"],
      run: async ({ arg }) => {
        const path = contextPath(arg);
        if (!path) return info("Open or select a file to compare");
        const other = await pickFile(path);
        if (!other || other === path) return;
        await openDiff(compareFilesData(path, other));
      },
    },
    {
      id: "diff.compareFiles",
      title: "Compare Files",
      category: "Diff",
      icon: "diff",
      when: "projectOpen",
      run: async ({ arg }) => {
        const paths = argPaths(arg).filter((p) => !p.endsWith("/"));
        if (paths.length !== 2) return info("Select two files to compare");
        await openDiff(compareFilesData(paths[0]!, paths[1]!));
      },
    },
    {
      id: "diff.compareWithClipboard",
      title: "Compare with Clipboard",
      category: "Diff",
      icon: "diff",
      when: "projectOpen",
      run: async ({ arg }) => {
        const path = contextPath(arg);
        if (!path) return info("Open or select a file to compare with the clipboard");
        let clipboard: string;
        try {
          clipboard = (await navigator.clipboard?.readText()) ?? "";
        } catch {
          return info("The clipboard could not be read");
        }
        const ed = activeEditor();
        const sel = ed && ed.ctx.path === path ? ed.view.state.selection.main : null;
        const selection = sel && !sel.empty ? ed!.view.state.sliceDoc(sel.from, sel.to) : null;
        await openDiff(clipboardDiffData(path, clipboard, selection));
      },
    },
    {
      // Parameterised: { path, title?, left: { text, label }, right: { text, label }, line? }.
      id: "diff.compareTexts",
      title: "Compare Texts",
      category: "Diff",
      hidden: true,
      run: async ({ arg }) => {
        const a = parseTextsArg(arg);
        if (!a) return;
        await openDiff({
          path: a.path,
          title: a.title,
          line: a.line,
          left: { type: "text", text: a.left.text, label: a.left.label },
          right: { type: "text", text: a.right.text, label: a.right.label },
        });
      },
    },
  ]);
}
