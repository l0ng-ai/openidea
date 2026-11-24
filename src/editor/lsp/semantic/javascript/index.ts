/**
 * JavaScript and TypeScript (tsserver), coloured as WebStorm does: a decorator's
 * whole name (`@Component`, `@Outer.Inner`) is a decorator, not the class or
 * function the server reports; a variable or function without tsserver's `local`
 * modifier is a module-level global.
 */
import { Tree, TreeBuffer, type NodeSet, type SyntaxNode } from "@lezer/common";
import { registerLanguageSemantics, type LanguageSemantics, type SemanticRange } from "../languages";

const decoratorTypes = new WeakMap<NodeSet, number>();

function decoratorType(set: NodeSet): number {
  let id = decoratorTypes.get(set);
  if (id === undefined) decoratorTypes.set(set, (id = set.types.find((t) => t.name === "Decorator")?.id ?? -1));
  return id;
}

/**
 * Subtrees without a decorator. An incremental parse keeps most of the old tree's nodes as they are,
 * so after an edit only the nodes on the changed path are scanned again, not the whole file.
 */
const decoratorFree = new WeakSet<Tree | TreeBuffer>();

/** Appends the start of every `Decorator` node in `node` (which starts at `offset`) to `out`. */
function findDecorators(node: Tree | TreeBuffer, offset: number, out: number[], probe?: { visited: number }): void {
  if (decoratorFree.has(node)) return;
  if (probe) probe.visited++;
  const before = out.length;
  if (node instanceof Tree) {
    if (node.type.name === "Decorator") out.push(offset);
    for (let i = 0; i < node.children.length; i++)
      findDecorators(node.children[i]!, offset + node.positions[i]!, out, probe);
  } else {
    // [type, from, to, end of children] per node; `from` is relative to the buffer.
    const type = decoratorType(node.set);
    if (type >= 0)
      for (let i = 0; i < node.buffer.length; i += 4)
        if (node.buffer[i] === type) out.push(offset + node.buffer[i + 1]!);
  }
  if (out.length === before) decoratorFree.add(node);
}

/**
 * The names of decorators, left of their arguments: `@A`, `@a.B`, `@A()`, `@a.B<T>()`.
 * `probe` counts the tree nodes looked at (tests).
 */
export function decoratorRanges(tree: Tree, probe?: { visited: number }): SemanticRange[] {
  const starts: number[] = [];
  findDecorators(tree, 0, starts, probe);
  const out: SemanticRange[] = [];
  for (const from of starts) {
    // The innermost node starting there is the `@` token.
    let decorator: SyntaxNode | null = tree.resolve(from, 1);
    while (decorator && decorator.name !== "Decorator") decorator = decorator.parent;
    if (!decorator) continue;
    // The node after `@`.
    let head = decorator.firstChild?.nextSibling ?? null;
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
  }
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
