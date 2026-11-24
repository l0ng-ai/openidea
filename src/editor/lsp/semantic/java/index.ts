import { registerLanguageSemantics, type LanguageSemantics } from "../languages";
import { javaEscapeRanges } from "./escapes";

const javaSemantics: LanguageSemantics = {
  syntaxRanges: (tree, doc) => javaEscapeRanges(tree, doc),
  // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
  tokenClasses({ classes }) {
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
  },
};

registerLanguageSemantics("java", javaSemantics);
