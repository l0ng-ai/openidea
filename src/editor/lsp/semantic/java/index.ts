import { registerLanguageSemantics, type LanguageSemantics } from "../languages";
import { isReassignedAt } from "./reassigned";

const javaSemantics: LanguageSemantics = {
  // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
  tokenClasses({ classes, from, doc, tree }) {
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
    if (tree && isReassignedAt(tree, doc, from)) classes.push("cm-sem-mutable");
  },
};

registerLanguageSemantics("java", javaSemantics);
