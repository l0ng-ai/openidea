/**
 * JavaScript and TypeScript (tsserver), coloured as WebStorm does: a decorator's
 * whole name (`@Component`, `@Outer.Inner`) is a decorator, not the class or
 * function the server reports; a variable or function without tsserver's `local`
 * modifier is a module-level global.
 */
import type { Tree } from "@lezer/common";
import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";

/** The names of decorators, left of their arguments: `@A`, `@a.B`, `@A()`, `@a.B<T>()`. */
export function decoratorRanges(tree: Tree): SemanticRange[] {
  const out: SemanticRange[] = [];
  tree.iterate({
    enter(ref) {
      if (ref.name !== "Decorator") return;
      // The node after `@`.
      let head = ref.node.firstChild?.nextSibling ?? null;
      while (head) {
        if (head.name === "CallExpression") head = head.firstChild;
        else if (head.name === "MemberExpression") {
          const name = head.lastChild;
          if (name?.name === "PropertyName")
            out.push({ from: name.from, to: name.to, className: "cm-sem-annotation", source: "syntax" });
          head = head.firstChild;
        } else {
          if (head.name === "VariableName")
            out.push({ from: head.from, to: head.to, className: "cm-sem-annotation", source: "syntax" });
          head = null;
        }
      }
    },
  });
  return out;
}

const javascriptSemantics: LanguageSemantics = {
  syntaxRanges: (tree) => decoratorRanges(tree),
  tokenClasses({ type, modifiers, classes, marksLocals }) {
    if (!marksLocals || modifiers.includes("local") || modifiers.includes("defaultLibrary")) return;
    if (type === "variable" && !classes.includes("cm-sem-constant")) classes.push("cm-sem-global");
    else if (type === "function") classes.push("cm-sem-global-function");
  },
};

registerLanguageSemantics(["javascript", "javascriptreact", "typescript", "typescriptreact"], javascriptSemantics);
