import { EditorView } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { InlayHint, Range } from "../src/bindings";
import { commands } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { lspDoc } from "../src/editor/lsp/lsp";
import { inlayExtension } from "../src/editor/lsp/inlay";
import { lspTheme } from "../src/editor/lsp/theme";
import "../src/styles/tokens.css";

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
    resolve(index: number, label = `hint-${index}`) {
      const request = requests[index]!;
      request.resolve([
        {
          position: { line: request.range.start.line + 1, col: 4 },
          label,
          kind: "type",
          paddingLeft: false,
          paddingRight: false,
          tooltip: null,
          parts: [],
        },
      ]);
    },
    wrap: () => view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.lineWrapping) }),
    destroy: () => view.destroy(),
  },
});
