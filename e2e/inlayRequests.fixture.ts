import { EditorView } from "@codemirror/view";
import { commands, type InlayHint, type Range } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { lspDoc } from "../src/editor/lsp/lsp";
import { inlayExtension } from "../src/editor/lsp/inlay";
import { lspTheme } from "../src/editor/lsp/theme";

const requests: { range: Range; resolve: (hints: InlayHint[]) => void }[] = [];
setInvokeRoute(() => null);
commands.lspInlayHints = async (_doc, range) =>
  new Promise((resolve) => requests.push({ range, resolve: (data) => resolve({ status: "ok", data }) }));

const view = new EditorView({
  parent: document.body,
  doc: Array.from({ length: 2000 }, (_, i) => `let item${i} = value;`).join("\n"),
  extensions: [
    EditorView.theme({ "&": { height: "400px" }, ".cm-scroller": { overflow: "auto" } }),
    lspTheme,
    lspDoc.of({ doc: 1, path: "demo.rs", language: "rust", uiMode: "Rust", readOnly: false }),
    inlayExtension(),
  ],
});

Object.assign(window, {
  inlayTest: {
    count: () => requests.length,
    resolve(index: number) {
      const request = requests[index]!;
      request.resolve([
        {
          position: { line: request.range.start.line + 1, col: 4 },
          label: `hint-${index}`,
          kind: "type",
          paddingLeft: false,
          paddingRight: false,
          tooltip: null,
          parts: [],
        },
      ]);
    },
    destroy: () => view.destroy(),
  },
});
