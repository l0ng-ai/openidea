import { registerLanguageSemantics } from "../languages";

registerLanguageSemantics("cpp", {
  tokenClasses({ type, classes }) {
    // clangd marks std and other library namespaces as defaultLibrary; keep their namespace colour.
    if (type !== "namespace") return;
    const builtin = classes.indexOf("cm-sem-builtin");
    if (builtin >= 0) classes.splice(builtin, 1);
  },
});
