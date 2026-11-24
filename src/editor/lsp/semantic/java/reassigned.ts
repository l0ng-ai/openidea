/**
 * IDEA's "Reassigned local variable" / "Reassigned parameter" (underlined by default): jdtls has no
 * modifier for it, so the parse tree finds them. Names resolve by scope, not by text, so a shadowing
 * field or a same-named variable elsewhere stays plain.
 *
 * Rules (IDEA's `ControlFlowUtil.isReassigned`): a parameter (method, lambda, catch, for-each, pattern)
 * counts once it is assigned at all; a local once a second assignment may follow the first, i.e. an
 * initialised local that is assigned again, two assignments outside exclusive branches, or one inside
 * a loop the local is declared outside of. `final` variables and try-with-resources resources never count.
 *
 * Limit: no real control flow, so `if (a) { x = 1; return; } x = 2;` is judged by branch structure only.
 * An old-style `case` group falls into the next unless its last statement is a `break`, `continue`,
 * `return` or `throw`.
 */
import type { SyntaxNode, Tree } from "@lezer/common";
import type { Text } from "@codemirror/state";

interface Variable {
  param: boolean;
  initialized: boolean;
  /** The scope node it was declared in. */
  scope: SyntaxNode;
  /** Start offsets of the declaration and every use. */
  names: number[];
  writes: SyntaxNode[];
}

/** `null` marks a field: it shadows outer locals and is never underlined. */
type Scope = Map<string, Variable | null>;

const SCOPES = new Set([
  "Block",
  "MethodDeclaration",
  "ConstructorDeclaration",
  "CompactConstructorDeclaration",
  "LambdaExpression",
  "ForStatement",
  "EnhancedForStatement",
  "CatchClause",
  "TryWithResourcesStatement",
  "SwitchBlock",
  "SwitchRule",
]);
const CLASS_BODIES = new Set(["ClassBody", "InterfaceBody", "EnumBody", "AnnotationTypeBody", "RecordBody"]);
const LOOPS = new Set(["WhileStatement", "DoStatement", "ForStatement", "EnhancedForStatement"]);

const cache = new WeakMap<Tree, Set<number>>();

/** Whether the name starting at `from` declares or uses a reassigned local or parameter. */
export function isReassignedAt(tree: Tree, doc: Text, from: number): boolean {
  let starts = cache.get(tree);
  if (!starts) cache.set(tree, (starts = reassignedNames(tree, doc)));
  return starts.has(from);
}

/** Start offsets of every declaration and use of a reassigned local or parameter. */
export function reassignedNames(tree: Tree, doc: Text): Set<number> {
  const text = (n: SyntaxNode) => doc.sliceString(n.from, n.to);
  const variables: Variable[] = [];
  const scopes: Array<{ node: SyntaxNode; names: Scope }> = [];
  const lookup = (name: string) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const v = scopes[i]!.names.get(name);
      if (v !== undefined) return v;
    }
    return null;
  };

  const declare = (def: SyntaxNode) => {
    const scope = scopes.at(-1);
    if (!scope) return;
    const owner = def.parent!;
    const declaration = owner.name === "VariableDeclarator" ? owner.parent : owner;
    let param = true;
    switch (declaration?.name) {
      case "LocalVariableDeclaration":
        param = false;
        break;
      case "FormalParameter":
      case "SpreadParameter":
      case "InferredParameters":
      case "LambdaExpression":
      case "ForSpec":
      case "CatchFormalParameter":
      case "TypePattern":
        break;
      case "Resource":
        // Implicitly final; still shadows outer names.
        scope.names.set(text(def), null);
        return;
      default:
        // Fields are collected per class body; methods and types are not variables.
        return;
    }
    let final = false;
    for (let c = declaration.firstChild; c && c.from < def.from; c = c.nextSibling)
      if (c.name === "Modifiers") final = c.getChild("final") != null;
    const v: Variable = {
      param,
      initialized: def.nextSibling?.name === "AssignOp",
      scope: scope.node,
      names: [def.from],
      writes: [],
    };
    scope.names.set(text(def), final ? null : v);
    if (!final) variables.push(v);
  };

  const fields = (body: SyntaxNode): Scope => {
    const names: Scope = new Map();
    const add = (def: SyntaxNode | null) => def && names.set(text(def), null);
    const members = (parent: SyntaxNode) => {
      for (let c = parent.firstChild; c; c = c.nextSibling)
        if (c.name === "FieldDeclaration" || c.name === "ConstantDeclaration")
          for (const d of c.getChildren("VariableDeclarator")) add(d.getChild("Definition"));
        else if (c.name === "EnumConstant") add(c.getChild("Definition"));
        else if (c.name === "EnumBodyDeclarations") members(c);
    };
    members(body);
    for (const c of body.parent?.getChild("RecordHeader")?.getChildren("RecordComponent") ?? [])
      add(c.getChild("Definition"));
    return names;
  };

  // A cursor walk: syntax nodes are only built for scopes, declarations and resolved names.
  tree.iterate({
    enter(ref) {
      if (SCOPES.has(ref.name)) scopes.push({ node: ref.node, names: new Map() });
      else if (CLASS_BODIES.has(ref.name)) scopes.push({ node: ref.node, names: fields(ref.node) });
      else if (ref.name === "Definition") declare(ref.node);
      else if (ref.name === "Identifier") {
        const v = lookup(doc.sliceString(ref.from, ref.to));
        if (!v) return;
        const node = ref.node;
        if (isMemberName(node)) return;
        v.names.push(node.from);
        if (isWriteTarget(node)) v.writes.push(node);
      }
    },
    leave(ref) {
      if (SCOPES.has(ref.name) || CLASS_BODIES.has(ref.name)) scopes.pop();
    },
  });

  const out = new Set<number>();
  for (const v of variables) if (isReassigned(v)) for (const n of v.names) out.add(n);
  return out;
}

/** `b` in `a.b` and method names are not variable references. */
function isMemberName(node: SyntaxNode) {
  const parent = node.parent;
  return parent?.name === "MethodName" || (parent?.name === "FieldAccess" && node.prevSibling?.name === ".");
}

function isWriteTarget(node: SyntaxNode) {
  const parent = node.parent;
  if (parent?.name === "UpdateExpression") return true;
  return parent?.name === "AssignmentExpression" && parent.firstChild?.from === node.from;
}

function isReassigned(v: Variable) {
  if (!v.writes.length) return false;
  if (v.param || v.initialized) return true;
  if (v.writes.some((w) => inLoopBelow(w, v.scope))) return true;
  // Pairwise, but a local has few assignments.
  for (let i = 0; i < v.writes.length; i++)
    for (let j = i + 1; j < v.writes.length; j++) if (!exclusive(v.writes[i]!, v.writes[j]!)) return true;
  return false;
}

function inLoopBelow(node: SyntaxNode, scope: SyntaxNode) {
  for (let n = node.parent; n && !same(n, scope); n = n.parent) if (LOOPS.has(n.name)) return true;
  return false;
}

/** Whether at most one of the two writes can run: different branches of an `if`, `?:` or `switch`. */
function exclusive(a: SyntaxNode, b: SyntaxNode) {
  const pathA = ancestors(a);
  const pathB = ancestors(b);
  let i = 0;
  while (i < pathA.length && i < pathB.length && same(pathA[i]!, pathB[i]!)) i++;
  const common = pathA[i - 1];
  const childA = pathA[i];
  const childB = pathB[i];
  if (!common || !childA || !childB) return false;
  switch (common.name) {
    case "IfStatement":
    case "TernaryExpression": {
      // The condition runs before either branch.
      const condition = common.name === "IfStatement" ? common.getChild("ParenthesizedExpression") : common.firstChild;
      return !!condition && !same(childA, condition) && !same(childB, condition);
    }
    case "SwitchBlock": {
      if (childA.name === "SwitchRule") return true;
      const [first, second] = childA.from < childB.from ? [childA, childB] : [childB, childA];
      return !fallsInto(first, second);
    }
    default:
      return false;
  }
}

/** Root-first ancestors of `node`, itself included. */
function ancestors(node: SyntaxNode) {
  const path: SyntaxNode[] = [];
  for (let n: SyntaxNode | null = node; n; n = n.parent) path.push(n);
  return path.reverse();
}

const same = (a: SyntaxNode, b: SyntaxNode) => a.from === b.from && a.to === b.to && a.name === b.name;

const JUMPS = new Set(["BreakStatement", "ContinueStatement", "ReturnStatement", "ThrowStatement"]);

/** Whether an old-style switch can run on from statement `first` to `second`: no case group between them ends in a jump. */
function fallsInto(first: SyntaxNode, second: SyntaxNode) {
  let last: SyntaxNode | null = first;
  for (let n = first.nextSibling; n && !same(n, second); n = n.nextSibling) {
    if (n.name === "SwitchLabel") {
      if (last && jumps(last)) return false;
      last = null;
    } else if (n.name !== ":") last = n;
  }
  return true;
}

function jumps(node: SyntaxNode): boolean {
  if (node.name !== "Block") return JUMPS.has(node.name);
  const statement = node.lastChild?.prevSibling;
  return !!statement && jumps(statement);
}
