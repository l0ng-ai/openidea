/** Creates a file from a template and fills it through the editor. */
import { tx } from "@/platform/i18n";
import { notifyFileOperation } from "@/platform/fileOps";
import { EditorSelection } from "@codemirror/state";
import { executeAction } from "@/platform/actions";
import { call, commands, isTauri } from "@/platform/ipc";
import { dirname, useProject } from "@/platform/project";
import { currentRoots } from "@/platform/projectRoots";
import { activeEditor, editorsFor, type TextEditorHandle } from "@/editor/api";
import { editorService, maybeEditorService, notifications } from "@/workbench/contributions";
import {
  GO_PACKAGE_RE,
  caretAfterReformat,
  composerPsr4,
  inferGoPackage,
  inferJvmPackage,
  inferPhpNamespace,
  planFile,
  reformatsOnCreate,
  renderFileTemplate,
  withKind,
  type FileTemplate,
  type FileTemplateKind,
} from "./model";
import { BUILTIN_FILE_TEMPLATES } from "./builtins";
import { templateIncludes } from "./store";

async function siblingGoPackage(directory: string): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const entries = await call(commands.fsReadDir(directory));
    const file =
      entries.find((e) => e.kind === "file" && e.name.endsWith(".go") && !e.name.endsWith("_test.go")) ??
      entries.find((e) => e.kind === "file" && e.name.endsWith(".go"));
    if (!file) return null;
    const text = await call(commands.fsReadText(file.path));
    const pkg = GO_PACKAGE_RE.exec(text)?.[1] ?? null;
    return pkg?.endsWith("_test") ? pkg.slice(0, -5) : pkg;
  } catch {
    return null;
  }
}

const JVM_BUILD = /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/;

/** JVM source and test roots (project-relative) that packages are counted from. */
function packageRoots(): string[] {
  return currentRoots()
    .filter((r) => (r.kind === "source" || r.kind === "test") && (!r.detectedFrom || JVM_BUILD.test(r.detectedFrom)))
    .map((r) => r.path);
}

/** The namespace from the nearest composer.json between `directory` and the project root (PSR-4). */
async function composerNamespace(directory: string, root: string | null): Promise<string> {
  if (!isTauri()) return "";
  let dir = directory.replace(/\/+$/, "");
  const top = root?.replace(/\/+$/, "") ?? null;
  for (;;) {
    let text: string | null = null;
    try {
      text = await call(commands.fsReadText(`${dir}/composer.json`));
    } catch {
      /* no composer.json here */
    }
    if (text !== null) return inferPhpNamespace(directory.slice(dir.length), composerPsr4(text));
    if (!top || dir === top || !dir.startsWith(`${top}/`)) return "";
    dir = dirname(dir);
  }
}

export function packageStyleFor(t: FileTemplate): FileTemplate["packageStyle"] {
  const dot = t.fileName?.lastIndexOf(".") ?? -1;
  const extension = t.fileName === undefined ? t.extension : dot > 0 ? t.fileName.slice(dot + 1) : "";
  return (
    t.packageStyle ??
    (t.inferPackage
      ? BUILTIN_FILE_TEMPLATES.find((b) => b.packageStyle && b.extension.toLowerCase() === extension.toLowerCase())
          ?.packageStyle
      : undefined)
  );
}

export async function packageFor(t: FileTemplate, directory: string): Promise<string> {
  const root = useProject.getState().project?.root ?? null;
  const style = packageStyleFor(t);
  if (style === "jvm") return inferJvmPackage(directory, root, packageRoots());
  if (style === "go") return inferGoPackage(directory, root, await siblingGoPackage(directory));
  if (style === "php") return composerNamespace(directory, root);
  return "";
}

function waitForEditor(path: string, timeoutMs = 4000): Promise<TextEditorHandle | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const h = editorsFor(path)[0] ?? (activeEditor()?.ctx.path === path ? activeEditor() : null);
      if (h) resolve(h);
      else if (Date.now() - started > timeoutMs) resolve(null);
      else setTimeout(tick, 30);
    };
    tick();
  });
}

function userName(root: string): string {
  return /^\/(?:Users|home)\/([^/]+)/.exec(root)?.[1] ?? "";
}

/** Default target directory: the active file's folder, else the project root. */
export function defaultDirectory(): string | null {
  const path = maybeEditorService()?.activePath();
  return path ? dirname(path) : (useProject.getState().project?.root ?? null);
}

/**
 * Creates `input` (a name, possibly with sub-directories) in `directory`
 * from `kind`, opens it and inserts the rendered body with the caret at
 * `$END$`. Throws with a user-facing message on failure.
 */
export async function createFromTemplate(
  t: FileTemplate,
  kind: FileTemplateKind,
  directory: string,
  input: string,
  /** Called once the file exists (e.g. to close the dialog before the editor takes focus). */
  onCreated?: () => void,
  variables?: Readonly<Record<string, string>>,
  cancelled?: () => boolean,
): Promise<string> {
  const plan = planFile(withKind(t, kind), directory, input);
  if (!plan) throw new Error(tx("Invalid file name"));
  const project = useProject.getState().project;
  const packageName = await packageFor(withKind(t, kind), plan.directory);
  const { text, caret } = renderFileTemplate(
    kind.body,
    {
      variables,
      name: plan.name,
      fileName: plan.fileName,
      packageName,
      projectName: project?.name,
      user: userName(project?.root ?? ""),
    },
    templateIncludes(),
  );
  if (cancelled?.()) return plan.path;
  await call(commands.fsCreateFile(plan.path));
  notifyFileOperation({ kind: "created", paths: [plan.path] });
  onCreated?.();
  await new Promise((r) => setTimeout(r, 0));
  await editorService().openFile(plan.path, { focus: true });
  const handle = await waitForEditor(plan.path);
  if (!handle) {
    notifications().notify({
      level: "warning",
      title: `Created ${plan.fileName}`,
      body: "The template content could not be inserted.",
    });
    return plan.path;
  }
  const { view } = handle;
  if (text && view.state.doc.length === 0) {
    view.dispatch({
      changes: { from: 0, insert: text },
      selection: EditorSelection.cursor(Math.min(caret, text.length)),
      scrollIntoView: true,
      userEvent: "input",
    });
    view.focus();
    if (reformatsOnCreate(t)) {
      // Keep the caret at `$END$` whatever edits the formatter made.
      const before = view.state.doc.toString();
      const at = view.state.selection.main.head;
      const applied = await editorService().reformat?.(plan.path);
      const after = view.state.doc.toString();
      if (applied && after !== before)
        view.dispatch({
          selection: EditorSelection.cursor(caretAfterReformat(before, at, after)),
          scrollIntoView: true,
        });
    }
    await executeAction("file.save");
  }
  return plan.path;
}
