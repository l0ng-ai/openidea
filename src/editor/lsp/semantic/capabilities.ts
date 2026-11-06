/**
 * Capability flags for languages that need no behaviour folder of their own:
 * they only carry entries that other features consult through the registry.
 */
import { registerLanguageSemantics } from "./languages";

// The server offers Generate (constructors, accessors, overrides…); elsewhere
// the Generate shortcut yields to the New popup, as in IDEA.
registerLanguageSemantics(
  [
    "java",
    "kotlin",
    "scala",
    "groovy",
    "rust",
    "go",
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
    "c",
    "cpp",
    "objective-c",
    "objective-cpp",
    "csharp",
    "swift",
    "dart",
    "php",
  ],
  { generate: true },
);

// The server completes import/require specifiers itself; file completion stays out of them.
registerLanguageSemantics(["javascript", "typescript", "javascriptreact", "typescriptreact", "vue", "svelte"], {
  serverCompletesModuleSpecifiers: true,
});

// Shorthand fields (`{ x }`, `S { x }`) name both a key and a variable when renaming.
registerLanguageSemantics(["javascript", "javascriptreact", "typescript", "typescriptreact", "rust"], {
  shorthandRename: true,
});

// Grammar-based syntax-error highlights are noise for these languages.
registerLanguageSemantics(["sql", "plaintext"], { skipSyntaxErrors: true });

// Web references (`href`, `class`, `var(--x)`) resolve without a language server,
// labelled by the reference kind in diagnostics.
registerLanguageSemantics(["html", "vue", "svelte"], { webReferenceSource: "HTML" });
registerLanguageSemantics(["css", "scss", "less"], { webReferenceSource: "CSS" });
