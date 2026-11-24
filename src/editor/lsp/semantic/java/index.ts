import { registerLanguageSemantics, type LanguageSemantics } from "../languages";
import { javaDeclarationRanges } from "./declarations";

const javaSemantics: LanguageSemantics = {
  fallbackRanges: (tree) => javaDeclarationRanges(tree),
  // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
  tokenClasses({ type, modifiers, classes }) {
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
    // jdtls sends `static final` fields as `property` + `static readonly`; IDEA colours them as constants.
    if (type === "property" && modifiers.includes("static") && modifiers.includes("readonly"))
      classes[classes.indexOf("cm-sem-property")] = "cm-sem-constant";
  },
};

registerLanguageSemantics("java", javaSemantics);
