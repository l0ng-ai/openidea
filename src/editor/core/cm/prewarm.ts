import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorContributions, type EditorDocContext } from "@/editor/api";
import { baseExtensions } from "./setup";

/**
 * Builds and drops an off-screen editor with the file editors' setup, so the first file opened
 * does not also pay for compiling the editor code and mounting its stylesheets. The document is
 * virtual and empty, and only contributions that accept such editors (`embedded`) take part:
 * nothing reaches a language server or the file system.
 */
export function prewarmEditor(): void {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:240px;visibility:hidden;contain:strict";
  document.body.appendChild(host);
  const ctx: EditorDocContext = {
    doc: -1,
    path: "prewarm.txt",
    language: "plaintext",
    uiMode: null,
    readOnly: true,
    virtual: true,
  };
  const contributions: Extension[] = [];
  for (const c of editorContributions()) {
    if (!c.embedded) continue;
    try {
      contributions.push(c.extensions(ctx));
    } catch {
      // Warming is best effort: the real editor reports a failing contribution.
    }
  }
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "",
      extensions: baseExtensions({
        ctx,
        settings: undefined,
        info: undefined,
        language: null,
        docLength: 0,
        indent: { tabSize: 4, insertSpaces: true },
        wrapOverride: false,
        contributions,
      }),
    }),
  });
  // One frame so its measure pass runs too, then nothing of it is left behind.
  requestAnimationFrame(() => {
    view.destroy();
    host.remove();
  });
}
