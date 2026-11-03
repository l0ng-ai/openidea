/** Real CodeMirror mouse/navigation path with a deliberately slow IPC boundary.
 * Semantic correctness and JVM timings live in the real-JDT configuration harness.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { commands } from "../src/platform/ipc";
import { usePlatform } from "../src/platform/platformInfo";
import { provideEditorService } from "../src/workbench/contributions";
import { lspDoc } from "../src/editor/lsp/lsp";
import { navigationExtension } from "../src/editor/lsp/navigation";
import { hoverExtension } from "../src/editor/lsp/hover";
import { lspTheme } from "../src/editor/lsp/theme";

Object.assign(window, { __TAURI_INTERNALS__: {} });
usePlatform.setState({ os: "macos" });
document.body.innerHTML = `<style>
body { --link: #215cc8; font: 16px monospace; margin: 32px; } button { margin: 12px; }
.cm-editor { border: 1px solid #888; min-height: 160px; font: 18px monospace; }
</style><button id="back">Back to configuration</button><button id="edit">Edit Java target</button>
<div id="config"></div><div id="java" hidden></div>
<output id="requests">0</output><output id="opened"></output>`;
const configHost = document.querySelector<HTMLDivElement>("#config")!;
const javaHost = document.querySelector<HTMLDivElement>("#java")!;
let requests = 0;
let hoverRequests = 0;
let targetLine = 0;
let clickedAt = 0;
const latency: number[] = [];
commands.lspGoto = async () => {
  document.querySelector("#requests")!.textContent = String(++requests);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    status: "ok",
    data: [
      {
        path: "/fixture/Settings.java",
        uri: null,
        range: { start: { line: targetLine, col: 24 }, end: { line: targetLine, col: 31 } },
      },
    ],
  };
};
commands.lspHover = async () => {
  hoverRequests++;
  return {
    status: "ok",
    data: { contents: { kind: "plaintext", value: "dingtalk.driver-class-name String" }, range: null },
  };
};
commands.lspDocumentLinks = async () => ({ status: "ok", data: [] });
commands.lspDocumentHighlights = async () => ({ status: "ok", data: [] });
commands.cancelRequest = async () => ({ status: "ok", data: null });
const java = new EditorView({
  parent: javaHost,
  state: EditorState.create({
    doc: "class Settings { String agentId; }",
    extensions: [
      lspDoc.of({ doc: 2, path: "/fixture/Settings.java", language: "java", uiMode: "Java", readOnly: false }),
      navigationExtension(),
    ],
  }),
});
const config = new EditorView({
  parent: configHost,
  state: EditorState.create({
    doc: "dingtalk:\n  driver-class-name: demo\n",
    extensions: [
      EditorState.languageData.of(() => [{ wordChars: "-" }]),
      lspDoc.of({ doc: 1, path: "/fixture/application.yml", language: "yaml", uiMode: "YAML", readOnly: false }),
      navigationExtension(),
      hoverExtension(),
      lspTheme,
    ],
  }),
});
config.contentDOM.addEventListener(
  "mousedown",
  () => {
    clickedAt = performance.now();
  },
  true,
);
provideEditorService({
  openFile: async (path, options) => {
    javaHost.hidden = false;
    configHost.hidden = true;
    java.dispatch({ selection: { anchor: java.state.doc.line((options?.selection?.line ?? 0) + 1).from + 24 } });
    document.querySelector("#opened")!.textContent = `${path}:${options?.selection?.line}`;
    latency.push(performance.now() - clickedAt);
  },
} as Parameters<typeof provideEditorService>[0]);
document.querySelector("#back")!.addEventListener("click", () => {
  javaHost.hidden = true;
  configHost.hidden = false;
});
document.querySelector("#edit")!.addEventListener("click", () => {
  java.dispatch({ changes: { from: 0, insert: "// moved\n" } });
  targetLine++;
});
Object.assign(window, { navigationMetrics: () => ({ requests, hoverRequests, latency, injectedServerDelayMs: 500 }) });
