import type { SyntaxNode, Tree } from "@lezer/common";
import type { Text } from "@codemirror/state";

interface PythonRange {
  from: number;
  to: number;
  className: string;
  source: "pythonSyntax" | "pythonFallback";
}

const BUILTIN_TYPES = new Set([
  "int",
  "str",
  "bool",
  "bytes",
  "float",
  "complex",
  "list",
  "dict",
  "tuple",
  "set",
  "frozenset",
  "object",
  "type",
  "None",
]);

function hasAncestor(node: SyntaxNode, name: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent.name === name) return true;
  return false;
}

function enclosingFunction(node: SyntaxNode | null): SyntaxNode | null {
  for (; node; node = node.parent) if (node.name === "FunctionDefinition") return node;
  return null;
}

/** Python categories absent from LSP tokens, derived from the editor's existing parse tree. */
export function pythonSyntaxRanges(tree: Tree, doc: Text): PythonRange[] {
  const ranges: PythonRange[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (!["VariableName", "PropertyName", "String", "Escape", "(", ")", "[", "]", "{", "}"].includes(node.name))
        return;
      const text = doc.sliceString(node.from, node.to);
      let style: string | undefined;
      if (["(", ")"].includes(node.name)) style = "python-parentheses";
      else if (["[", "]"].includes(node.name)) style = "python-brackets";
      else if (["{", "}"].includes(node.name)) style = "python-braces";
      else if (node.name === "VariableName") {
        if (node.parent?.name === "FunctionDefinition") {
          style = /^__.*__$/.test(text)
            ? "python-predefined-definition"
            : enclosingFunction(node.parent.parent)
              ? "python-nested"
              : "python-definition";
        } else if (hasAncestor(node, "TypeDef") && !BUILTIN_TYPES.has(text)) style = "python-annotation";
        else if ((text === "self" || text === "cls") && enclosingFunction(node.parent)) style = "self";
        else if (node.parent?.name === "ArgList" && node.nextSibling?.name === "AssignOp") style = "python-keyword-arg";
      } else if (node.name === "PropertyName" && /^__.*__$/.test(text)) style = "python-predefined-usage";
      else if (
        node.name === "PropertyName" &&
        node.parent?.name === "MemberExpression" &&
        node.parent.parent?.name === "CallExpression"
      )
        style = "python-method-call";
      else if (node.name === "String") {
        const statement = node.parent;
        const body = statement?.parent;
        let first = body?.firstChild;
        while (first && (first.name === ":" || first.name === "Comment")) first = first.nextSibling;
        const docstring =
          statement?.name === "ExpressionStatement" &&
          statement.firstChild?.from === node.from &&
          statement.firstChild?.to === node.to &&
          first?.from === statement.from &&
          (body?.name === "Script" ||
            (body?.name === "Body" && ["FunctionDefinition", "ClassDefinition"].includes(body.parent?.name ?? "")));
        if (docstring && !/^[bf]/i.test(text)) style = "python-docstring";
        else if (/^[rub]*b[rub]*['"]/i.test(text)) style = "python-bytes";
      } else if (node.name === "Escape") style = "python-escape";
      if (style) ranges.push({ from: node.from, to: node.to, className: `cm-sem-${style}`, source: "pythonSyntax" });
      if (style === "python-docstring") return false;
    },
  });
  return ranges;
}

const BUILTIN_NAMES = new Set(
  "abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ BaseException Exception ArithmeticError AssertionError AttributeError EOFError ImportError IndexError KeyError LookupError NameError NotImplementedError OSError OverflowError RuntimeError StopIteration SyntaxError TypeError UnboundLocalError ValueError ZeroDivisionError".split(
    " ",
  ),
);

function scope(node: SyntaxNode | null): SyntaxNode | null {
  for (; node; node = node.parent)
    if (["FunctionDefinition", "ClassDefinition", "Script"].includes(node.name)) return node;
  return null;
}

/** Fast local guesses while LSP is pending. Server tokens take precedence over these. */
export function pythonFallbackRanges(tree: Tree, doc: Text, rainbow?: (name: string) => string): PythonRange[] {
  const bindings = new Map<string, Map<string, string>>();
  const key = (node: SyntaxNode) => `${node.name}:${node.from}`;
  const bind = (node: SyntaxNode | null, name: string, kind: string) => {
    if (!node) return;
    let names = bindings.get(key(node));
    if (!names) bindings.set(key(node), (names = new Map()));
    names.set(name, kind);
  };
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name !== "VariableName") return;
      const parent = node.parent;
      const name = doc.sliceString(node.from, node.to);
      if (parent?.name === "FunctionDefinition" || parent?.name === "ClassDefinition")
        bind(scope(parent.parent), name, parent.name === "FunctionDefinition" ? "function" : "type");
      else if (parent?.name === "ParamList" && node.prevSibling?.name !== "AssignOp")
        bind(scope(parent), name, "parameter");
      else if (parent?.name === "AssignStatement" && parent.firstChild?.from === node.from)
        bind(scope(parent), name, "variable");
    },
  });
  const ranges: PythonRange[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name !== "VariableName" && node.name !== "PropertyName") return;
      const name = doc.sliceString(node.from, node.to);
      let kind: string | undefined;
      let owner = scope(node.parent);
      if (node.name === "PropertyName") kind = "property";
      else {
        let inFunction = false;
        for (let current = owner; current; current = scope(current.parent)) {
          if (current.name === "FunctionDefinition") inFunction = true;
          if (inFunction && current.name === "ClassDefinition") continue;
          kind = bindings.get(key(current))?.get(name);
          if (kind) {
            owner = current;
            break;
          }
        }
        if (!kind && BUILTIN_NAMES.has(name)) kind = "builtin";
      }
      if (!kind) return;
      const local = kind === "parameter" || (kind === "variable" && owner?.name === "FunctionDefinition");
      if (kind === "variable" && owner?.name === "Script") kind = "global";
      else if (kind === "variable" && owner?.name === "ClassDefinition") kind = "property";
      const className = kind === "builtin" ? "cm-sem-builtin cm-sem-python-builtin" : `cm-sem-${kind}`;
      ranges.push({
        from: node.from,
        to: node.to,
        className: className + (local && rainbow && name !== "self" && name !== "cls" ? ` ${rainbow(name)}` : ""),
        source: "pythonFallback",
      });
    },
  });
  return ranges;
}
