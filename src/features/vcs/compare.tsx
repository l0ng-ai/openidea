/**
 * Compare entry points (IDEA's Compare With…, Compare Files, Compare with
 * Clipboard) and the diff viewer's own actions (F7 / ⇧F7, F4).
 */
import { activeEditor } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { isRemoteWindow } from "@/platform/remote";
import { maybeEditorService, notifications, projectViewSelection } from "@/workbench/contributions";
import { promptText } from "./dialogs";
import { focusedDiffNavigator } from "./diffNavigator";
import { compareFilesData, displayPath } from "./compareData";
import { showDirectoryComparison } from "./directoryCompareKind";
export { compareFilesData, displayPath } from "./compareData";
import { openDiff, openVcsDiff, type DiffData } from "./diffInput";
import { baseName } from "./model";
import { tx } from "@/platform/i18n";
import { readClipboardPlainText } from "@/platform/clipboard";
import { workflowSettings } from "@/platform/workflowSettings";

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

/** Clipboard ↔ the file (editable) or ↔ the editor selection. */
export function clipboardDiffData(path: string, clipboard: string, selection: string | null): DiffData {
  return {
    path,
    swappable: true,
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

let blankDiffs = 0;

/** Open Blank Diff Window: two empty sides to type or paste into; the editor's selection fills the left one. */
export function blankDiffData(selection: string | null): DiffData {
  return {
    // A path of its own, so each blank diff gets a new tab.
    path: `blank-diff:${++blankDiffs}`,
    title: tx("Blank Diff"),
    left: { type: "text", text: selection ?? "", label: "", editable: true },
    right: { type: "text", text: "", label: "", editable: true },
    swappable: true,
  };
}

function info(title: string) {
  notifications().notify({ group: "vcs", level: "info", title });
}

async function pickFile(near: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@/platform/dialog");
  const dir = near.slice(0, near.lastIndexOf("/")) || undefined;
  const picked = await open({ multiple: false, directory: false, title: "Compare With", defaultPath: dir });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

/**
 * The file to compare `path` against: the OS file dialog on the desktop; a
 * browser file picker's contents elsewhere (remote development / `pnpm dev`),
 * compared as text since no absolute path is available to the backend.
 */
async function pickComparison(
  path: string,
): Promise<{ type: "file"; path: string } | { type: "text"; text: string; label: string } | null> {
  if (isTauri()) {
    const picked = await pickFile(path);
    return picked ? { type: "file", path: picked } : null;
  }
  if (typeof document === "undefined") {
    info("Compare With needs the desktop app or a browser file picker");
    return null;
  }
  const chosen = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Chrome fires `cancel` (or focus returns) when the dialog is dismissed.
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
  if (!chosen) return null;
  return { type: "text", text: await chosen.text(), label: chosen.name };
}

const contextPath = (arg: unknown) => argPath(arg) ?? maybeEditorService()?.activePath() ?? undefined;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await call(commands.fsEntryKind(path))) === "dir";
  } catch {
    return false;
  }
}

async function pickDirectory(near: string): Promise<string | null> {
  if (isRemoteWindow() || !isTauri()) {
    const picked = await promptText({ title: "Compare With", label: "Directory path", initial: near, mono: true });
    return picked?.value ?? null;
  }
  const { open } = await import("@/platform/dialog");
  const picked = await open({ multiple: false, directory: true, title: tx("Compare With"), defaultPath: near });
  return (Array.isArray(picked) ? picked[0] : picked) ?? null;
}

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
      // Diff.FocusOppositePane; it beats the Switcher's ⌃⇧⇥ while a side-by-side diff is focused.
      id: "diff.focusOppositePane",
      title: "Select Opposite Diff Pane",
      category: "Diff",
      when: "diffEditorFocus",
      keyWhen: "diffEditorFocus && !popupOpen",
      enabled: () => (focusedDiffNavigator()?.viewer?.()?.panes().length ?? 0) > 1,
      run: () => void focusedDiffNavigator()?.focusOpposite(),
    },
    {
      // CloseDiffEditor: Esc in a diff tab that nothing in the diff takes (see DiffEditor).
      id: "diff.closeEditor",
      title: "Close Diff Editor",
      category: "Diff",
      when: "diffEditorFocus",
      run: () => void focusedDiffNavigator()?.close(),
    },
    {
      id: "diff.swapSides",
      title: "Swap Sides",
      description: "Swaps the left and right sides of the diff",
      category: "Diff",
      icon: "swap-panels",
      when: "diffEditorFocus",
      run: () => void focusedDiffNavigator()?.swapSides(),
    },
    {
      id: "diff.showInExternalTool",
      title: "Show Diff in External Tool",
      category: "Diff",
      icon: "external-tools",
      when: "diffEditorFocus",
      enabled: () => {
        const { enabled, path } = workflowSettings().externalDiff;
        return enabled && !!path;
      },
      run: () => void focusedDiffNavigator()?.showInExternalTool(),
    },
    {
      id: "diff.openBlankDiff",
      title: "Open Blank Diff Window",
      description: "Opens two editors side by side to compare their content",
      category: "Diff",
      icon: "diff",
      keywords: ["empty diff", "new diff", "compare text", "paste"],
      run: () => {
        const ed = activeEditor();
        const sel = ed?.view.state.selection.main;
        return openDiff(blankDiffData(sel && !sel.empty ? ed!.view.state.sliceDoc(sel.from, sel.to) : null));
      },
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
      keywords: ["diff", "compare files", "compare folders"],
      run: async ({ arg }) => {
        const path = argPath(arg) ?? projectViewSelection()[0] ?? contextPath(arg);
        if (!path) return info("Open or select a file to compare");
        const directoryArg = !!arg && typeof arg === "object" && "directory" in arg && arg.directory === true;
        if (directoryArg || (isTauri() && (await isDirectory(path)))) {
          const other = await pickDirectory(path);
          if (!other || other === path) return;
          if (!(await isDirectory(other))) return info("Select a directory to compare");
          showDirectoryComparison(path, other);
          return;
        }
        const other = await pickComparison(path);
        if (!other) return;
        if (other.type === "file") {
          if (other.path === path) return;
          await openVcsDiff({ ...compareFilesData(path, other.path), swappable: true });
        } else {
          await openVcsDiff({
            path,
            left: { type: "text", text: other.text, label: other.label },
            right: { type: "worktree", label: displayPath(path) },
            swappable: true,
          });
        }
      },
    },
    {
      id: "diff.compareDirectories",
      title: "Compare Directories",
      category: "Diff",
      icon: "diff",
      when: "projectOpen",
      keywords: ["diff", "folders", "compare folders"],
      run: async ({ arg }) => {
        const paths = arg === undefined ? projectViewSelection() : argPaths(arg);
        if (paths.length !== 2 || !(await isDirectory(paths[0]!)) || !(await isDirectory(paths[1]!)))
          return info("Select two directories to compare");
        showDirectoryComparison(paths[0]!, paths[1]!);
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
        await openVcsDiff({ ...compareFilesData(paths[0]!, paths[1]!), swappable: true });
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
          clipboard = await readClipboardPlainText();
        } catch {
          return info("The clipboard could not be read");
        }
        const ed = activeEditor();
        const sel = ed && ed.ctx.path === path ? ed.view.state.selection.main : null;
        const selection = sel && !sel.empty ? ed!.view.state.sliceDoc(sel.from, sel.to) : null;
        await openVcsDiff(clipboardDiffData(path, clipboard, selection));
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
        await openVcsDiff({
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
