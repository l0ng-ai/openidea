import { registerLanguageSemantics, type LanguageSemantics } from "../languages";

const goSemantics: LanguageSemantics = {
  tokenClasses({ type, modifiers, classes }) {
    if (type === "variable") {
      if (modifiers.includes("readonly") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-constant");
      else if (modifiers.includes("static") && !classes.includes("cm-sem-constant")) classes.push("cm-sem-global");
    }
    if (type === "label") classes.push("cm-sem-constant");
  },
  isLocal: ({ type, modifiers }) => type === "parameter" || (type === "variable" && !modifiers.includes("readonly")),
};

registerLanguageSemantics("go", goSemantics);
