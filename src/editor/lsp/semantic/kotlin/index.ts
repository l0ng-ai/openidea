import type { Text } from "@codemirror/state";
import { registerLanguageSemantics, type LanguageSemantics } from "../languages";

const NAME = /[A-Za-z_][\w]*/y;

/**
 * The names of annotation usages (`@Column`, `@field:Column`, `@Outer.Inner`), as `"from:to"` → `"annotation"`.
 * An `@` right after a name is a label (`return@forEach`, `this@Outer`, `loop@`), not an annotation.
 */
function annotationNames(doc: Text): Map<string, string> {
  const out = new Map<string, string>();
  const text = doc.toString();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (/[\w`]/.test(text[at - 1] ?? "")) continue;
    let pos = at + 1;
    const name = () => {
      NAME.lastIndex = pos;
      const m = NAME.exec(text);
      return m ? { from: pos, to: pos + m[0].length } : null;
    };
    let first = name();
    // A use-site target (`@field:`, `@get:`, `@file:`) precedes the annotation's name.
    if (first && text[first.to] === ":" && text[first.to + 1] !== ":") {
      pos = first.to + 1;
      first = name();
    }
    for (let part = first; part;) {
      out.set(`${part.from}:${part.to}`, "annotation");
      if (text[part.to] !== ".") break;
      pos = part.to + 1;
      part = name();
    }
  }
  return out;
}

const kotlinSemantics: LanguageSemantics = {
  symbolKinds: (_tree, doc) => annotationNames(doc),
  tokenClasses({ type, modifiers, kind, classes }) {
    // JetBrains Kotlin LSP reports an annotation usage as a constructor call (`method`);
    // IDEA colours the name as an annotation (Metadata), like its `@`.
    if (kind === "annotation" && type !== "label") {
      classes.length = 0;
      classes.push("cm-sem-annotation");
      return;
    }
    if (type === "operator" && modifiers.includes("declaration")) classes.push("cm-sem-function");
    // JetBrains Kotlin LSP uses `modification` for mutable declarations and references.
    if ((type === "variable" || type === "property" || type === "parameter") && modifiers.includes("modification"))
      classes.push("cm-sem-mutable");
    if (type === "label") classes.push("cm-sem-constant");
  },
};

registerLanguageSemantics("kotlin", kotlinSemantics);
