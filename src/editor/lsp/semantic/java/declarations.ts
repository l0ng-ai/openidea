import type { SyntaxNode, Tree } from "@lezer/common";
import type { SemanticRange } from "../languages";

const CONSTANT = "cm-sem-constant cm-sem-static cm-sem-declaration";

// The classes jdtls's token for the declared name produces: [instance, static, static final].
const DECLARATIONS: Record<string, readonly [string, string, string]> = {
  FieldDeclaration: [
    "cm-sem-property cm-sem-declaration",
    "cm-sem-property cm-sem-static cm-sem-declaration",
    CONSTANT,
  ],
  // Interface fields: implicitly `static final`.
  ConstantDeclaration: [CONSTANT, CONSTANT, CONSTANT],
  EnumConstant: [CONSTANT, CONSTANT, CONSTANT],
  MethodDeclaration: [
    "cm-sem-function cm-sem-declaration",
    "cm-sem-function cm-sem-static cm-sem-declaration",
    "cm-sem-function cm-sem-static cm-sem-declaration",
  ],
  ConstructorDeclaration: [
    "cm-sem-function cm-sem-declaration",
    "cm-sem-function cm-sem-declaration",
    "cm-sem-function cm-sem-declaration",
  ],
};

// 0: instance, 1: static, 2: static final.
const staticness = (decl: SyntaxNode) => {
  const mods = decl.getChild("Modifiers");
  if (!mods?.getChild("static")) return 0;
  return mods.getChild("final") ? 2 : 1;
};

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
      const className = classes[staticness(decl)];
      const declarators = decl.getChildren("VariableDeclarator");
      for (const owner of declarators.length ? declarators : [decl]) {
        const name = owner.getChild("Definition");
        if (name) out.push({ from: name.from, to: name.to, className, source: "fallback" });
      }
    },
  });
  return out;
}
