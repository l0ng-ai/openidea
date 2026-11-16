/**
 * Go to declaration in `pom.xml`: ⌘/Ctrl-click (or ⌘B) on a `${property}` reference
 * opens the `<properties>` entry that defines it — the POM's own, else one inherited
 * along the parent chain (a parent POM outside the project opens from the local
 * repository, read-only as a plain file) — and a dependency / plugin whose version a
 * `<dependencyManagement>` / `<pluginManagement>` entry provides opens that managing
 * declaration; otherwise a dependency, plugin or `<parent>` opens the artifact's own POM
 * (a project module's, else the local repository's). The backend resolves both with the build model's POM reader and parent
 * resolver; here only cheap eligibility is computed (a reference span, an artifact
 * element), so the ⌘-hover underline stays out of the rest of the file, and nothing
 * resolves to no jump at all: an unresolvable property or parent never navigates
 * somewhere unrelated.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { CONTRIBUTED_DEFINITION, type ContributedDefinition, type EditorDocContext, whenSynced } from "@/editor/api";
import { showHint } from "@/editor/lsp/hint";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { editorService } from "@/workbench/contributions";

/** The `${property}` reference covering `at`, if any (clicking the `$` counts). */
export function propertyRefAt(text: string, at: number): { from: number; to: number } | null {
  const open = text.startsWith("${", at) ? at : text.lastIndexOf("${", at - 1);
  if (open < 0) return null;
  const close = text.indexOf("}", open + 2);
  if (close < 0 || close < at) return null;
  return { from: open, to: close + 1 };
}

/** Whether an opener of `name` before `at` has no closer of it yet (POM elements do not nest). */
function inside(name: string, text: string, at: number): boolean {
  const before = text.slice(0, at);
  const count = (re: RegExp) => (before.match(re) ?? []).length;
  return count(new RegExp(`<${name}[\\s>]`, "g")) > count(new RegExp(`</${name}\\s*>`, "g"));
}

/**
 * Whether `at` may sit in a `<dependency>` / `<plugin>` / `<parent>` element: an
 * eligibility test only (a `<dependency>` inside a comment counts too) — what the
 * element resolves to is the backend's answer.
 */
export function inArtifactElement(text: string, at: number): boolean {
  return inside("dependency", text, at) || inside("plugin", text, at) || inside("parent", text, at);
}

/** Go to declaration in a POM of the project (or an opened parent POM of the local repository). */
export function pomNavigationExtension(ctx: EditorDocContext): Extension {
  if (ctx.virtual || !/(^|\/)pom\.xml$/.test(ctx.path)) return [];
  const eligible = (state: EditorState, pos: number) => {
    const text = state.doc.toString();
    return propertyRefAt(text, pos) !== null || inArtifactElement(text, pos);
  };
  const definition: ContributedDefinition = (view, pos) => {
    if (!eligible(view.state, pos)) return false;
    const doc = view.state.doc;
    const line = doc.lineAt(pos);
    void whenSynced(view)
      .then(() =>
        call(
          commands.mavenGotoDeclaration(ctx.path, {
            line: line.number - 1,
            col: pos - line.from,
          }),
        ),
      )
      .then((goto) => {
        if (!goto) {
          showHint(view, tx`Cannot find declaration to go to`);
          return;
        }
        if (view.state.doc !== doc) return; // The user kept typing while the POM resolved.
        void editorService().openFile(goto.path, {
          selection: {
            line: goto.range.start.line,
            col: goto.range.start.col,
            endLine: goto.range.end.line,
            endCol: goto.range.end.col,
          },
        });
      })
      .catch((e: unknown) =>
        showHint(view, e instanceof Error ? e.message : String(e), {
          tone: "error",
        }),
      );
    return true;
  };
  return EditorState.languageData.of((state, pos) =>
    eligible(state, pos) ? [{ [CONTRIBUTED_DEFINITION]: definition }] : [],
  );
}
