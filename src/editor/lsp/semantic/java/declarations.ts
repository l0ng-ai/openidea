import type { SyntaxNode, Tree } from "@lezer/common";
import type { SemanticRange } from "../languages";

// The classes jdtls's token for the declared name produces: [instance, static].
const DECLARATIONS: Record<string, readonly [string, string]> = {
  FieldDeclaration: ["cm-sem-property cm-sem-declaration", "cm-sem-property cm-sem-static cm-sem-declaration"],
  // Interface fields: implicitly `static final`.
  ConstantDeclaration: [
    "cm-sem-property cm-sem-static cm-sem-declaration",
    "cm-sem-property cm-sem-static cm-sem-declaration",
  ],
  EnumConstant: [
    "cm-sem-constant cm-sem-static cm-sem-declaration",
    "cm-sem-constant cm-sem-static cm-sem-declaration",
  ],
  MethodDeclaration: ["cm-sem-function cm-sem-declaration", "cm-sem-function cm-sem-static cm-sem-declaration"],
  ConstructorDeclaration: ["cm-sem-function cm-sem-declaration", "cm-sem-function cm-sem-declaration"],
};

const isStatic = (decl: SyntaxNode) => decl.getChild("Modifiers")?.getChild("static") != null;

/**
 * Declaration names coloured from the parse tree while jdtls has not answered (startup, project import,
 * jdtls missing), with the classes its tokens give them, so nothing changes colour when they arrive.
 * References are left alone: a bare name can be a field or a local, and only jdtls knows which.
 */
export function javaDeclarationRanges(tree: Tree): SemanticRange[] {
  const out: SemanticRange[] = [];
  tree.iterate({
    enter(cursor) {
      const classes = Object.hasOwn(DECLARATIONS, cursor.name) ? DECLARATIONS[cursor.name] : undefined;
      if (!classes) return;
      const decl = cursor.node;
      const className = classes[isStatic(decl) ? 1 : 0];
      const declarators = decl.getChildren("VariableDeclarator");
      for (const owner of declarators.length ? declarators : [decl]) {
        const name = owner.getChild("Definition");
        if (name) out.push({ from: name.from, to: name.to, className, source: "fallback" });
      }
    },
  });
  return out;
}
