import { EditorView } from "@codemirror/view";
import { commands } from "../src/platform/ipc";
import { setInvokeRoute } from "../src/platform/tauriCore";
import { schemeCss } from "../src/platform/colorScheme";
import { lspDoc } from "../src/editor/lsp/lsp";
import { semanticExtension } from "../src/editor/lsp/semantic";
import { lspTheme } from "../src/editor/lsp/theme";

// Lines: an instance method declaration, its call, a static method call, a local function call.
setInvokeRoute(() => null);
commands.lspSemanticTokens = async () => ({
  status: "ok",
  data: {
    tokenTypes: ["method", "member", "function"],
    tokenModifiers: ["declaration", "static", "local"],
    data: [0, 0, 5, 0, 0b001, 1, 0, 5, 1, 0, 2, 0, 6, 1, 0b010, 3, 0, 4, 2, 0b100],
  },
});
const methods = new URLSearchParams(location.search).has("methods");
const style = document.createElement("style");
style.textContent = schemeCss("dark", {
  dark: {
    functionDeclaration: { foreground: "#6688aa" },
    functionCall: { foreground: "#99bbdd" },
    ...(methods
      ? {
          "javascript.instanceMethod": { foreground: "#e06c75" },
          "javascript.staticMethod": { foreground: "#cf8e6d", italic: false },
        }
      : {}),
  },
});
document.head.append(style);
new EditorView({
  parent: document.body,
  doc: "count\ncount\ncreate\nhelp",
  extensions: [
    // The app's editors name their language; the JavaScript and TypeScript page's colours apply there.
    EditorView.editorAttributes.of({ "data-language": "TypeScript" }),
    lspTheme,
    lspDoc.of({ doc: 1, path: "demo.ts", language: "typescript", uiMode: "TypeScript", readOnly: false }),
    semanticExtension(),
  ],
});
