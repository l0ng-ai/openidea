import { EditorView } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { schemeCss } from "../src/platform/colorScheme";
import { openideaHighlightStyle } from "../src/editor/core/cm/highlight";
import { findLanguageDescription, loadSupport } from "../src/editor/core/cm/languages";
import { syntaxHighlightField, setSyntaxHighlights } from "../src/editor/core/cm/syntaxHighlight";
import { commands } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { lspDoc } from "../src/editor/lsp/lsp";
import { semanticExtension } from "../src/editor/lsp/semantic";
import { lspTheme } from "../src/editor/lsp/theme";

const semantic = new URLSearchParams(location.search).has("semantic");
setInvokeRoute(() => null);
commands.lspSemanticTokens = async () => ({
  status: "ok",
  data: {
    tokenTypes: ["operator", "parameter"],
    tokenModifiers: ["declaration", "modification"],
    data: [0, 4, 5, 0, 1, 0, 10, 6, 1, 2],
  },
});

const style = document.createElement("style");
style.textContent = schemeCss("dark", {
  dark: {
    "kotlin.functionDeclaration": { foreground: "#557799", background: "#ddeeff", bold: true },
    "kotlin.parameter": { foreground: "#6688aa" },
  },
});
document.head.append(style);
const host = document.createElement("section");
host.dataset.language = "Kotlin";
document.body.append(host);
const support = await loadSupport(findLanguageDescription("Kotlin", "Demo.kt")!);
const view = new EditorView({
  parent: host,
  doc: "fun greet(prefix: String) {}",
  extensions: [
    support!,
    syntaxHighlightField,
    syntaxHighlighting(openideaHighlightStyle),
    ...(semantic
      ? [
          lspTheme,
          lspDoc.of({ doc: 1, path: "Demo.kt", language: "kotlin", uiMode: "Kotlin", readOnly: false }),
          semanticExtension(),
        ]
      : []),
  ],
});
view.dispatch({ effects: setSyntaxHighlights.of({ kinds: ["function", "parameter"], data: [4, 9, 0, 10, 16, 1] }) });
