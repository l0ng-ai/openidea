import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { commands } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { schemeCss } from "../src/platform/colorScheme";
import { openideaHighlightStyle } from "../src/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "../src/editor/core/cm/languages";
import { lspDoc } from "../src/editor/lsp/lsp";
import { semanticExtension } from "../src/editor/lsp/semantic";
import { lspTheme } from "../src/editor/lsp/theme";

setInvokeRoute(() => null);
commands.lspSemanticTokens = async () => ({
  status: "ok",
  data: {
    tokenTypes: ["variable", "namespace", "function"],
    tokenModifiers: ["readonly", "static", "declaration", "deprecated"],
    data: [0, 6, 5, 0, 1, 1, 4, 6, 0, 2, 2, 0, 3, 1, 0, 3, 5, 5, 2, 14],
  },
});
const style = document.createElement("style");
style.textContent = schemeCss("dark", {
  dark: {
    "go.constant": { foreground: "#224466" },
    "go.globalVariable": { foreground: "#335577" },
  },
});
document.head.append(style);
const host = document.createElement("section");
host.dataset.language = "Go";
document.body.append(host);
const support = await loadSupport(findLanguageDescription("Go", "demo.go")!);
new EditorView({
  parent: host,
  doc: "const Limit = 3\nvar Global = 1\nfmt.Println(Global)\nfunc Greet() {}",
  extensions: [
    support!,
    syntaxHighlighting(openideaHighlightStyle),
    lspTheme,
    lspDoc.of({ doc: 1, path: "demo.go", language: "go", uiMode: "Go", readOnly: false }),
    semanticExtension(),
  ],
});
