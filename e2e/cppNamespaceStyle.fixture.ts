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
    tokenTypes: ["namespace"],
    tokenModifiers: ["defaultLibrary", "globalScope"],
    data: [0, 0, 7, 0, 2, 1, 0, 3, 0, 3],
  },
});
const mode = new URLSearchParams(location.search).has("light") ? "light" : "dark";
const style = document.createElement("style");
style.textContent = schemeCss(mode, {
  [mode]: {
    packageReference: { foreground: "#446688" },
    predefined: { foreground: "#cc5500" },
  },
});
document.head.append(style);
new EditorView({
  parent: document.body,
  doc: "example::hello();\nstd::cout << 1;",
  extensions: [
    lspTheme,
    lspDoc.of({ doc: 1, path: "demo.cpp", language: "cpp", uiMode: "C++", readOnly: false }),
    semanticExtension(),
  ],
});
