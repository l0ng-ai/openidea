import { EditorView } from "@codemirror/view";
import { commands } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { schemeCss } from "../src/platform/colorScheme";
import { lspDoc } from "../src/editor/lsp/lsp";
import { semanticExtension } from "../src/editor/lsp/semantic";
import { lspTheme } from "../src/editor/lsp/theme";

setInvokeRoute(() => null);
commands.lspSemanticTokens = async () => ({
  status: "ok",
  data: {
    tokenTypes: ["namespace", "class", "function", "parameter", "variable", "property", "selfTypeKeyword"],
    tokenModifiers: ["declaration", "static", "deprecated", "constant"],
    data: [
      0, 0, 7, 0, 0, 1, 0, 6, 1, 0, 2, 0, 6, 2, 1, 3, 0, 5, 3, 0, 4, 0, 5, 4, 8, 5, 0, 6, 2, 7, 6, 0, 5, 5, 6, 7, 0, 4,
      6, 0,
    ],
  },
});
const style = document.createElement("style");
style.textContent = schemeCss("dark", {
  dark: {
    keyword: { foreground: "#99bbdd", background: "#ddeeff", italic: true },
    packageReference: { foreground: "#446688", background: "#ddeeff", italic: true },
    className: { foreground: "#557799", background: "#ddeeff", bold: true },
    functionDeclaration: {
      foreground: "#6688aa",
      background: "#ddeeff",
      bold: true,
      italic: false,
      effect: "underline",
    },
    parameter: { foreground: "#7799bb", background: "#ddeeff", bold: true },
    constant: { foreground: "#88aacc", background: "#ddeeff", bold: true },
  },
});
document.head.append(style);
new EditorView({
  parent: document.body,
  doc: "package\nSample\nrender\ninput\nLimit\nlegacy\nfield\nSelf",
  extensions: [
    lspTheme,
    lspDoc.of({ doc: 1, path: "demo.ts", language: "typescript", uiMode: "TypeScript", readOnly: false }),
    semanticExtension(),
  ],
});
