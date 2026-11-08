import { registerLanguageSemantics, type LanguageSemantics } from "../languages";

const kotlinSemantics: LanguageSemantics = {
  tokenClasses({ type, modifiers, classes }) {
    if (type === "operator" && modifiers.includes("declaration")) classes.push("cm-sem-function");
    // JetBrains Kotlin LSP uses `modification` for mutable declarations and references.
    if ((type === "variable" || type === "property" || type === "parameter") && modifiers.includes("modification"))
      classes.push("cm-sem-mutable");
    if (type === "label") classes.push("cm-sem-constant");
  },
};

registerLanguageSemantics("kotlin", kotlinSemantics);
