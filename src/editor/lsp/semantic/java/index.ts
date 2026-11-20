import { registerLanguageSemantics, type LanguageSemantics } from "../languages";

const javaSemantics: LanguageSemantics = {
  // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
  tokenClasses({ classes }) {
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
  },
};

registerLanguageSemantics("java", javaSemantics);
