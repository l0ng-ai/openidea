import type { SyntaxNode, Tree } from "@lezer/common";
import type { Text } from "@codemirror/state";

interface PythonRange {
  from: number;
  to: number;
  className: string;
  source: "pythonSyntax" | "pythonFallback";
}

export type PythonSymbolKind =
  | "function"
  | "type"
  | "parameter"
  | "localVariable"
  | "globalVariable"
  | "instanceAttribute"
  | "classAttribute"
  | "constant"
  | "property"
  | "typeParameter"
  | "unusedParameter"
  | "builtin";

const PYTHON_CLASSES: Record<PythonSymbolKind, string> = {
  function: "cm-sem-function",
  type: "cm-sem-type",
  parameter: "cm-sem-parameter",
  localVariable: "cm-sem-variable cm-sem-python-local-variable",
  globalVariable: "cm-sem-global cm-sem-python-global-variable",
  instanceAttribute: "cm-sem-property cm-sem-python-instance-attribute",
  classAttribute: "cm-sem-property cm-sem-python-class-attribute",
  constant: "cm-sem-constant cm-sem-python-constant",
  property: "cm-sem-property cm-sem-python-property",
  typeParameter: "cm-sem-typeParameter cm-sem-python-type-parameter",
  unusedParameter: "cm-sem-parameter cm-sem-unused",
  builtin: "cm-sem-builtin cm-sem-python-builtin",
};

export const pythonSymbolClasses = (kind: PythonSymbolKind) => PYTHON_CLASSES[kind];

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

const FUNCTION_SCOPES = new Set(["FunctionDefinition", "LambdaExpression"]);
const COMPREHENSION_SCOPES = new Set([
  "ArrayComprehensionExpression",
  "DictionaryComprehensionExpression",
  "SetComprehensionExpression",
]);
const SCOPE_NODES = new Set([
  "FunctionDefinition",
  "LambdaExpression",
  "ClassDefinition",
  "TypeDefinition",
  "Script",
  ...COMPREHENSION_SCOPES,
]);
const PATTERN_CONTAINERS = new Set([
  "TupleExpression",
  "ArrayExpression",
  "ParenthesizedExpression",
  "SequencePattern",
  "PatternArgList",
  "StarPattern",
]);
const TYPE_VAR_CALLS = new Set(["TypeVar", "ParamSpec", "TypeVarTuple"]);
const KIND_PRIORITY: Record<PythonSymbolKind, number> = {
  globalVariable: 70,
  typeParameter: 90,
  parameter: 80,
  unusedParameter: 80,
  property: 80,
  constant: 70,
  classAttribute: 60,
  localVariable: 50,
  function: 40,
  type: 40,
  instanceAttribute: 40,
  builtin: 30,
};

function scope(node: SyntaxNode | null): SyntaxNode | null {
  for (; node; node = node.parent) if (SCOPE_NODES.has(node.name)) return node;
  return null;
}

const STUB_STATEMENTS = new Set(["PassStatement", "RaiseStatement"]);

/**
 * Whether the parameters `fn` doesn't read count as unused. Not for stubs (a body of only a
 * docstring, `...`, `pass` or `raise`), `@abstractmethod` / `@overload` / `@override`, dunder
 * methods or methods of a class with bases: those signatures are dictated elsewhere.
 */
function checksUnusedParameters(fn: SyntaxNode, doc: Text): boolean {
  if (fn.name !== "FunctionDefinition") return true;
  const name = directName(fn);
  if (name && /^__\w+__$/.test(doc.sliceString(name.from, name.to))) return false;
  if (fn.parent?.name === "DecoratedStatement")
    for (let d = fn.parent.firstChild; d; d = d.nextSibling)
      if (d.name === "Decorator" && /\b(?:abstractmethod|overload|override)\b/.test(doc.sliceString(d.from, d.to)))
        return false;
  const owner = scope(fn.parent);
  if (owner?.name === "ClassDefinition" && owner.getChild("ArgList")) return false;
  const body = fn.getChild("Body");
  for (let st = body?.firstChild; st; st = st.nextSibling) {
    if (st.name === ":" || st.name === "Comment" || STUB_STATEMENTS.has(st.name)) continue;
    const only = st.name === "ExpressionStatement" ? st.firstChild : null;
    if (only && !only.nextSibling && (only.name === "String" || only.name === "Ellipsis")) continue;
    return true;
  }
  return false;
}

function enclosingClass(node: SyntaxNode | null): SyntaxNode | null {
  for (; node; node = node.parent) if (node.name === "ClassDefinition") return node;
  return null;
}

function directName(node: SyntaxNode | null): SyntaxNode | null {
  for (let child = node?.firstChild; child; child = child.nextSibling) if (child.name === "VariableName") return child;
  return null;
}

function isConstantName(name: string): boolean {
  return /^_*[A-Z][A-Z0-9_]*$/.test(name);
}

function hasFinalAnnotation(node: SyntaxNode, doc: Text): boolean {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (
      (child.name === "VariableName" || child.name === "PropertyName") &&
      doc.sliceString(child.from, child.to) === "Final"
    )
      return true;
    if (hasFinalAnnotation(child, doc)) return true;
  }
  return false;
}

function callName(node: SyntaxNode | null, doc: Text): string | undefined {
  if (node?.name !== "CallExpression") return undefined;
  const callee = node.firstChild;
  if (callee?.name === "VariableName") return doc.sliceString(callee.from, callee.to);
  if (callee?.name === "MemberExpression") {
    const property = callee.getChild("PropertyName");
    if (property) return doc.sliceString(property.from, property.to);
  }
  return undefined;
}

function assignmentRight(node: SyntaxNode): SyntaxNode | null {
  const assign = node.getChild("AssignOp");
  return assign?.nextSibling ?? null;
}

function assignmentAnnotation(node: SyntaxNode): SyntaxNode | null {
  return node.getChild("TypeDef");
}

function collectPattern(node: SyntaxNode, out: SyntaxNode[]) {
  if (node.name === "VariableName" || node.name === "MemberExpression") {
    out.push(node);
    return;
  }
  if (!PATTERN_CONTAINERS.has(node.name)) return;
  for (let child = node.firstChild; child; child = child.nextSibling) collectPattern(child, out);
}

function assignmentTargets(node: SyntaxNode, stop: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === stop) break;
    if (child.name === "TypeDef") continue;
    collectPattern(child, out);
  }
  return out;
}

function forTargets(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  let collecting = false;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "for") {
      collecting = true;
      continue;
    }
    if (!collecting) continue;
    if (child.name === "in") break;
    collectPattern(child, out);
  }
  return out;
}

function aliasTargets(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "as") {
      const target = child.nextSibling;
      if (target) collectPattern(target, out);
    }
  }
  return out;
}

function isPropertyFunction(node: SyntaxNode, name: string, doc: Text): boolean {
  const decorated = node.parent;
  if (decorated?.name !== "DecoratedStatement") return false;
  for (let child = decorated.firstChild; child; child = child.nextSibling) {
    if (child.name !== "Decorator") continue;
    const decorator = doc.sliceString(child.from + 1, child.to).trim();
    if (decorator === "property" || decorator === "cached_property" || decorator.endsWith(".cached_property"))
      return true;
    const dot = decorator.lastIndexOf(".");
    if (
      dot > 0 &&
      decorator.slice(0, dot) === name &&
      ["setter", "getter", "deleter"].includes(decorator.slice(dot + 1))
    )
      return true;
  }
  return false;
}

/** Classifies every Python identifier from scope bindings; the server only distinguishes some of them. */
export function pythonSymbolKinds(tree: Tree, doc: Text): Map<string, PythonSymbolKind> {
  const bindings = new Map<string, Map<string, PythonSymbolKind>>();
  const classByName = new Map<string, SyntaxNode>();
  const classData = new Map<string, Set<string>>();
  const propertyNames = new Set<string>();
  const key = (node: SyntaxNode) => `${node.name}:${node.from}`;
  const text = (node: SyntaxNode) => doc.sliceString(node.from, node.to);
  const dataFor = (node: SyntaxNode) => {
    const scopeKey = key(node);
    let data = classData.get(scopeKey);
    if (!data) classData.set(scopeKey, (data = new Set()));
    return data;
  };
  const bind = (owner: SyntaxNode | null, name: string, kind: PythonSymbolKind) => {
    if (!owner) return;
    let names = bindings.get(key(owner));
    if (!names) bindings.set(key(owner), (names = new Map()));
    const previous = names.get(name);
    if (previous && KIND_PRIORITY[previous] >= KIND_PRIORITY[kind]) return;
    names.set(name, kind);
  };

  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name === "ClassDefinition") {
        const classNode = directName(node);
        if (classNode) {
          bind(scope(node.parent), text(classNode), "type");
          classByName.set(text(classNode), node);
          dataFor(node);
        }
      } else if (node.name === "TypeDefinition") {
        const typeNode = directName(node);
        if (typeNode) bind(scope(node.parent), text(typeNode), "type");
      } else if (node.name === "FunctionDefinition") {
        const functionNode = directName(node);
        if (!functionNode) return;
        const functionName = text(functionNode);
        const property = isPropertyFunction(node, functionName, doc);
        bind(scope(node.parent), functionName, property ? "property" : "function");
        if (property) {
          propertyNames.add(functionName);
        }
      } else if (node.name === "ParamList") {
        const owner = scope(node);
        for (let child = node.firstChild; child; child = child.nextSibling)
          if (child.name === "VariableName") bind(owner, text(child), "parameter");
      } else if (node.name === "TypeParam") {
        const param = directName(node);
        if (param) bind(scope(node), text(param), "typeParameter");
      } else if (node.name === "ScopeStatement" && node.firstChild?.name === "global") {
        const owner = scope(node);
        for (let child: SyntaxNode | null = node.firstChild; child; child = child.nextSibling)
          if (child.name === "VariableName") bind(owner, text(child), "globalVariable");
      }
      if (node.name === "CapturePattern") {
        const capture = directName(node);
        if (capture) {
          const owner = scope(node);
          const kind =
            owner?.name === "ClassDefinition"
              ? "classAttribute"
              : owner?.name === "Script"
                ? "globalVariable"
                : "localVariable";
          bind(owner, text(capture), kind);
        }
      }
    },
  });

  const assignmentKind = (owner: SyntaxNode | null, name: string, annotation: SyntaxNode | null): PythonSymbolKind => {
    if (annotation && hasFinalAnnotation(annotation, doc)) return "constant";
    if (isConstantName(name)) return "constant";
    if (owner?.name === "Script") return "globalVariable";
    if (owner?.name === "ClassDefinition") return "classAttribute";
    return "localVariable";
  };

  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name === "AssignStatement" || node.name === "UpdateStatement") {
        const stop = node.name === "AssignStatement" ? "AssignOp" : "UpdateOp";
        const owner = scope(node);
        const targets = assignmentTargets(node, stop);
        const annotation = node.name === "AssignStatement" ? assignmentAnnotation(node) : null;
        const called = node.name === "AssignStatement" ? callName(assignmentRight(node), doc) : undefined;
        const typeParameter = called !== undefined && TYPE_VAR_CALLS.has(called);
        for (const target of targets) {
          if (target.name === "MemberExpression") {
            const object = target.firstChild;
            const property = target.getChild("PropertyName");
            if (object?.name === "VariableName" && property && text(object) === "self") {
              const ownerClass = enclosingClass(node);
              if (ownerClass) dataFor(ownerClass).add(text(property));
            }
            continue;
          }
          const name = text(target);
          bind(owner, name, typeParameter ? "typeParameter" : assignmentKind(owner, name, annotation));
        }
      } else if (node.name === "NamedExpression") {
        const target = node.firstChild;
        if (target?.name === "VariableName")
          bind(scope(node), text(target), assignmentKind(scope(node), text(target), null));
      } else if (node.name === "ForStatement") {
        const owner = scope(node);
        for (const target of forTargets(node))
          if (target.name === "VariableName") bind(owner, text(target), assignmentKind(owner, text(target), null));
      } else if (COMPREHENSION_SCOPES.has(node.name)) {
        const owner = scope(node);
        for (const target of forTargets(node))
          if (target.name === "VariableName") bind(owner, text(target), "localVariable");
      } else if (node.name === "WithStatement" || node.name === "TryStatement") {
        const owner = scope(node);
        for (const target of aliasTargets(node))
          if (target.name === "VariableName") bind(owner, text(target), assignmentKind(owner, text(target), null));
      }
    },
  });

  const usedParameters = new Set<string>();
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name !== "VariableName" || hasAncestor(node, "ParamList")) return;
      const name = text(node);
      let crossedFunction = false;
      for (let current = scope(node); current; current = scope(current.parent)) {
        if (FUNCTION_SCOPES.has(current.name)) crossedFunction = true;
        const kind = bindings.get(key(current))?.get(name);
        if (!kind) continue;
        if (crossedFunction && current.name === "ClassDefinition" && kind !== "typeParameter") continue;
        if (kind === "parameter") usedParameters.add(`${key(current)}:${name}`);
        break;
      }
    },
  });

  const resolve = (
    node: SyntaxNode,
    name: string,
    start: SyntaxNode | null = scope(node),
  ): PythonSymbolKind | undefined => {
    let crossedFunction = false;
    for (let current = start; current; current = scope(current.parent)) {
      if (FUNCTION_SCOPES.has(current.name)) crossedFunction = true;
      const kind = bindings.get(key(current))?.get(name);
      if (!kind) continue;
      if (crossedFunction && current.name === "ClassDefinition" && kind !== "typeParameter") continue;
      return kind;
    }
    return undefined;
  };
  const classMember = (node: SyntaxNode | null, name: string) =>
    node ? bindings.get(key(node))?.get(name) : undefined;
  const memberKind = (node: SyntaxNode, name: string): PythonSymbolKind | undefined => {
    const member = node.parent;
    if (member?.name !== "MemberExpression") return undefined;
    const object = member.firstChild;
    if (!object) return undefined;
    const objectName = object.name === "VariableName" ? text(object) : undefined;
    const currentClass = enclosingClass(node);
    const namedClass = objectName ? classByName.get(objectName) : undefined;
    const owner = objectName === "self" || objectName === "cls" ? currentClass : namedClass;
    const bound = classMember(owner ?? null, name);
    const call = member.parent?.name === "CallExpression" && member.parent.firstChild?.from === member.from;
    if (call) return bound === "property" || bound === "constant" ? bound : undefined;
    if (objectName === "self" && currentClass) {
      if (bound === "property") return "property";
      if (owner && dataFor(owner).has(name)) return "instanceAttribute";
      if (bound) return bound;
      if (propertyNames.has(name)) return "property";
      if (isConstantName(name)) return "constant";
      return "instanceAttribute";
    }
    if (objectName === "cls" && currentClass) {
      if (bound) return bound;
      if (isConstantName(name)) return "constant";
      return "classAttribute";
    }
    if (namedClass) {
      if (bound) return bound;
      if (isConstantName(name)) return "constant";
      return "classAttribute";
    }
    if (propertyNames.has(name)) return "property";
    if (isConstantName(name)) return "constant";
    return "instanceAttribute";
  };
  const kindFor = (node: SyntaxNode): PythonSymbolKind | undefined => {
    const name = text(node);
    if (node.name === "PropertyName") return memberKind(node, name);
    if (node.parent?.name === "ParamList") {
      const owner = scope(node);
      if (
        owner &&
        name !== "self" &&
        name !== "cls" &&
        !name.startsWith("_") &&
        !usedParameters.has(`${key(owner)}:${name}`) &&
        checksUnusedParameters(owner, doc)
      )
        return "unusedParameter";
    }
    const start = node.parent?.name === "FunctionDefinition" ? scope(node.parent.parent) : scope(node);
    const resolved = resolve(node, name, start);
    if (resolved) return resolved;
    if (isConstantName(name) && !BUILTIN_NAMES.has(name)) return "constant";
    return undefined;
  };

  const out = new Map<string, PythonSymbolKind>();
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name !== "VariableName" && node.name !== "PropertyName") return;
      const kind = kindFor(node);
      if (kind) out.set(`${node.from}:${node.to}`, kind);
    },
  });
  return out;
}

/** Python categories absent from LSP tokens, derived from the editor's existing parse tree. */
export function pythonSyntaxRanges(
  tree: Tree,
  doc: Text,
  symbols: Map<string, PythonSymbolKind> = pythonSymbolKinds(tree, doc),
): PythonRange[] {
  const ranges: PythonRange[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (
        ![
          "VariableName",
          "PropertyName",
          "String",
          "FormatString",
          "type",
          "Escape",
          "(",
          ")",
          "[",
          "]",
          "{",
          "}",
        ].includes(node.name)
      )
        return;
      if (node.name === "FormatString") {
        const className = "cm-sem-python-fstring";
        let from = node.from;
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== "FormatReplacement") continue;
          if (child.from > from) ranges.push({ from, to: child.from, className, source: "pythonSyntax" });
          from = child.to;
        }
        if (from < node.to) ranges.push({ from, to: node.to, className, source: "pythonSyntax" });
        return;
      }
      const text = doc.sliceString(node.from, node.to);
      const symbol = symbols.get(`${node.from}:${node.to}`);
      let style: string | undefined;
      let className: string | undefined;
      if (["(", ")"].includes(node.name)) style = "python-parentheses";
      else if (["[", "]"].includes(node.name)) style = "python-brackets";
      else if (["{", "}"].includes(node.name)) style = "python-braces";
      else if (node.name === "VariableName") {
        if (symbol === "typeParameter" || symbol === "unusedParameter") className = pythonSymbolClasses(symbol);
        else if (node.parent?.name === "FunctionDefinition") {
          if (symbol === "property") className = pythonSymbolClasses(symbol);
          else
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
      else if (node.name === "type" && node.parent?.name === "TypeDefinition") style = "keyword";
      if (style) className = `cm-sem-${style}`;
      if (className) ranges.push({ from: node.from, to: node.to, className, source: "pythonSyntax" });
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

/** Fast local guesses while LSP is pending. Server tokens take precedence over these. */
export function pythonFallbackRanges(
  tree: Tree,
  doc: Text,
  rainbow?: (name: string) => string,
  symbols: Map<string, PythonSymbolKind> = pythonSymbolKinds(tree, doc),
): PythonRange[] {
  const ranges: PythonRange[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name !== "VariableName" && node.name !== "PropertyName") return;
      const name = doc.sliceString(node.from, node.to);
      const kind =
        symbols.get(`${node.from}:${node.to}`) ??
        (node.name === "VariableName" && BUILTIN_NAMES.has(name) ? "builtin" : undefined);
      if (!kind) return;
      const local = kind === "parameter" || kind === "localVariable";
      ranges.push({
        from: node.from,
        to: node.to,
        className:
          pythonSymbolClasses(kind) +
          (local && rainbow && name !== "self" && name !== "cls" ? ` ${rainbow(name)}` : ""),
        source: "pythonFallback",
      });
    },
  });
  return ranges;
}
