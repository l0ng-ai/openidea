/**
 * Python's semantic highlighting beyond the LSP tokens (PyCharm's category
 * colours): symbol kinds from the parse tree, syntax ranges the server never
 * reports, and fallbacks while the server is pending.
 */
import type { LanguageSemantics } from "../languages";
import { registerLanguageSemantics } from "../languages";
import {
  pythonFallbackRanges,
  pythonSymbolClasses,
  pythonSymbolKinds,
  pythonSyntaxRanges,
  type PythonSymbolKind,
} from "./highlight";
import { implementPythonAbstractMethods, pythonMemberIntentions } from "./members";

/** Server tokens these kinds override: the kind's own classes replace the generic ones. */
const VARIABLE_KINDS = new Set<PythonSymbolKind>([
  "localVariable",
  "globalVariable",
  "instanceAttribute",
  "classAttribute",
  "constant",
  "property",
  "typeParameter",
  "unusedParameter",
]);
const SYMBOL_BASES = new Set([
  "cm-sem-variable",
  "cm-sem-global",
  "cm-sem-property",
  "cm-sem-constant",
  "cm-sem-type",
  "cm-sem-typeParameter",
  "cm-sem-parameter",
  "cm-sem-builtin",
]);

const pythonSemantics: LanguageSemantics = {
  symbolKinds: pythonSymbolKinds,
  syntaxRanges: (tree, doc, symbols, format) =>
    pythonSyntaxRanges(tree, doc, symbols as Map<string, PythonSymbolKind>, format),
  fallbackRanges: (tree, doc, rainbow, symbols) =>
    pythonFallbackRanges(tree, doc, rainbow, symbols as Map<string, PythonSymbolKind>),
  tokenClasses({ type, modifiers, kind, classes }) {
    if (modifiers.includes("static")) classes.push("cm-sem-python-static");
    if (type === "method") classes.push("cm-sem-python-method-call");
    if (modifiers.includes("defaultLibrary")) classes.push("cm-sem-python-builtin");
    if (kind && VARIABLE_KINDS.has(kind as PythonSymbolKind)) {
      for (let j = classes.length - 1; j >= 0; j--) if (SYMBOL_BASES.has(classes[j]!)) classes.splice(j, 1);
      classes.push(...pythonSymbolClasses(kind as PythonSymbolKind).split(" "));
    }
  },
  isLocal: ({ type, kind }) => (kind ? kind === "localVariable" || kind === "parameter" : type === "parameter"),
  intentions: pythonMemberIntentions,
  implementMethods: implementPythonAbstractMethods,
};

registerLanguageSemantics("python", pythonSemantics);
