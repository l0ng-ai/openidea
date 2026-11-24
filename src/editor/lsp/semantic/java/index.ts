import { registerLanguageSemantics, type LanguageSemantics } from "../languages";

const TYPE_TOKENS = new Set(["class", "interface", "enum", "record", "annotation", "type", "typeParameter"]);

const javaSemantics: LanguageSemantics = {
  // Java colours JDK types and calls like any other: `defaultLibrary` (sent for JDK symbols) gets no colour of its own.
  tokenClasses({ type, classes }) {
    const i = classes.indexOf("cm-sem-builtin");
    if (i >= 0) classes.splice(i, 1);
    // Nested types are `static` in Java, but IntelliJ italicises only static members, never type names.
    if (TYPE_TOKENS.has(type)) {
      const s = classes.indexOf("cm-sem-static");
      if (s >= 0) classes.splice(s, 1);
    }
  },
};

registerLanguageSemantics("java", javaSemantics);
