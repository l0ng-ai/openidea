/**
 * PyCharm's "Create function / class / method" quick fixes on an unresolved
 * reference. Python servers only offer an import or a suppression comment; the
 * server says what is unresolved, the parse tree says where and how it is used.
 */
import { syntaxTree, indentUnit } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { ContributedIntention } from "@/editor/api";
import { tx } from "@/platform/i18n";
import { docOf } from "../../lsp";
import type { EditorDiagnostic } from "../../diagnostics";

/** Unresolved-name and missing-attribute codes of basedpyright/pyright, Ruff, ty and pyrefly. */
const UNDEFINED_NAME = new Set(["reportUndefinedVariable", "F821", "unresolved-reference", "unknown-name"]);
const MISSING_ATTRIBUTE = new Set(["reportAttributeAccessIssue", "unresolved-attribute", "missing-attribute"]);

export interface CreateFix {
  kind: "function" | "class" | "method";
  name: string;
  /** The class a method goes into. */
  owner?: string;
  insert: { from: number; text: string };
  /** Offset of the `pass` placeholder inside `text`. */
  body: number;
}

const PASS = "pass";
const indentOf = (doc: Text, pos: number) => /^\s*/.exec(doc.lineAt(pos).text)![0];

/**
 * Parameter names for the arguments of `args` (an ArgList), in an order a `def` accepts.
 * Keyword names are kept, since callers pass them by name. The receiver, positional
 * and starred parameters are made unique using Python's identifier normalization.
 */
function paramsFor(args: SyntaxNode | null, doc: Text, receiver?: string): string[] {
  if (!args) return receiver ? [receiver] : [];
  const groups: SyntaxNode[][] = [[]];
  for (let c = args.firstChild; c; c = c.nextSibling) {
    if (c.name === "(" || c.name === ")" || c.name === "Comment") continue;
    if (c.name === ",") groups.push([]);
    else groups[groups.length - 1]!.push(c);
  }
  const positional: string[] = [];
  const keyword = new Map<string, string>();
  let star = false;
  let starStar = false;
  for (const g of groups) {
    const [first, second] = g;
    if (!first) continue;
    if (first.name === "*") star = true;
    else if (first.name === "**") starStar = true;
    else if (second?.name === "AssignOp") {
      const name = doc.sliceString(first.from, first.to);
      keyword.set(name.normalize("NFKC"), name);
    } else if (g.length === 1 && first.name === "VariableName") positional.push(doc.sliceString(first.from, first.to));
    else positional.push("");
  }
  const used = new Set(keyword.keys());
  const unique = (base: string) => {
    let name = base;
    for (let i = 1; used.has(name.normalize("NFKC")); i++) name = `${base}${i}`;
    used.add(name.normalize("NFKC"));
    return name;
  };
  const leading = receiver ? [unique(receiver)] : [];
  const named = positional.map((name) => name && unique(name));
  let next = 0;
  const parameters = named.map((name) => {
    if (name) return name;
    let placeholder: string;
    do placeholder = `param${++next}`;
    while (used.has(placeholder));
    return unique(placeholder);
  });
  const args_ = star ? [`*${unique("args")}`] : [];
  const kwargs = starStar ? [`**${unique("kwargs")}`] : [];
  return [...leading, ...parameters, ...args_, ...keyword.values(), ...kwargs];
}

function topLevel(node: SyntaxNode): SyntaxNode | null {
  for (let n: SyntaxNode | null = node; n; n = n.parent) if (n.parent?.name === "Script") return n;
  return null;
}

function outsideParentheses(node: SyntaxNode): SyntaxNode {
  while (node.parent?.name === "ParenthesizedExpression") node = node.parent;
  return node;
}

/** The call `node` (a name or attribute) is the callee of, if any. */
function callOf(node: SyntaxNode): SyntaxNode | null {
  const callee = outsideParentheses(node);
  const call = callee.parent;
  return call?.name === "CallExpression" && call.firstChild?.from === callee.from && call.firstChild.to === callee.to
    ? call
    : null;
}

function functionText(
  name: string,
  params: string[],
  indent: string,
  unit: string,
  { awaited = false, decorator = "" }: { awaited?: boolean; decorator?: string } = {},
) {
  const head = `${decorator}${indent}${awaited ? "async " : ""}def ${name}(${params.join(", ")}):\n${indent}${unit}`;
  return { text: head + PASS, body: head.length };
}

/** Fixes for an unresolved name at `from..to`. */
export function createForName(tree: Tree, doc: Text, from: number, unit: string): CreateFix[] {
  const node = tree.resolveInner(from, 1);
  if (node.name !== "VariableName") return [];
  const statement = topLevel(node);
  if (!statement) return [];
  const name = doc.sliceString(node.from, node.to);
  const call = callOf(node);
  const args = call?.getChild("ArgList") ?? null;
  const at = statement.from;
  const gap = "\n\n\n";
  const fixes: CreateFix[] = [];
  if (call) {
    const f = functionText(name, paramsFor(args, doc), "", unit, {
      awaited: outsideParentheses(call).parent?.name === "AwaitExpression",
    });
    fixes.push({ kind: "function", name, insert: { from: at, text: f.text + gap }, body: f.body });
  }
  const initParams = paramsFor(args, doc, "self");
  const init = initParams.length > 1 ? functionText("__init__", initParams, unit, unit) : null;
  const head = `class ${name}:\n`;
  const cls = init
    ? { text: head + init.text, body: head.length + init.body }
    : { text: head + unit + PASS, body: head.length + unit.length };
  fixes.push({ kind: "class", name, insert: { from: at, text: cls.text + gap }, body: cls.body });
  return fixes;
}

/** A fix for a missing method called on `self`/`cls` inside its class, the attribute at `from`. */
export function createForAttribute(tree: Tree, doc: Text, from: number, unit: string): CreateFix[] {
  const property = tree.resolveInner(from, 1);
  const member = property.parent;
  if (property.name !== "PropertyName" || member?.name !== "MemberExpression") return [];
  const call = callOf(member);
  const receiver = member.firstChild;
  if (!call || receiver?.name !== "VariableName") return [];
  let fn: SyntaxNode | null = member;
  while (fn && fn.name !== "FunctionDefinition") fn = fn.parent;
  const holder = fn?.parent?.name === "DecoratedStatement" ? fn.parent : fn;
  const cls = holder?.parent?.parent;
  if (!fn || cls?.name !== "ClassDefinition") return [];
  const first = fn.getChild("ParamList")?.getChild("VariableName");
  const self = doc.sliceString(receiver.from, receiver.to);
  if (!first || doc.sliceString(first.from, first.to).normalize("NFKC") !== self.normalize("NFKC")) return [];
  // The new method is of the kind of the one calling it; a static method has no receiver.
  const decorators = (holder === fn ? [] : holder!.getChildren("Decorator")).map(
    (d) => /^@\s*([\w.]+)/.exec(doc.sliceString(d.from, d.to))?.[1],
  );
  if (decorators.includes("staticmethod") || decorators.includes("builtins.staticmethod")) return [];
  const name = doc.sliceString(property.from, property.to);
  const owner = doc.sliceString(cls.getChild("VariableName")!.from, cls.getChild("VariableName")!.to);
  const indent = indentOf(doc, holder!.from);
  const classMethod = decorators.includes("classmethod") || decorators.includes("builtins.classmethod");
  const f = functionText(name, paramsFor(call.getChild("ArgList"), doc, self), indent, unit, {
    awaited: outsideParentheses(call).parent?.name === "AwaitExpression",
    decorator: classMethod ? `${indent}@classmethod\n` : "",
  });
  const body = cls.getChild("Body")!;
  const end = doc.lineAt(body.from + doc.sliceString(body.from, body.to).trimEnd().length).to;
  return [{ kind: "method", name, owner, insert: { from: end, text: `\n\n${f.text}` }, body: 2 + f.body }];
}

function label(fix: CreateFix): string {
  const { name, owner } = fix;
  if (fix.kind === "function") return tx`Create function '${name}'`;
  if (fix.kind === "class") return tx`Create class '${name}'`;
  return tx`Create method '${name}' in '${owner}'`;
}

export function createFixes(state: EditorState, from: number, to: number): CreateFix[] {
  const tree = syntaxTree(state);
  const unit = state.facet(indentUnit);
  const fixes: CreateFix[] = [];
  const seen = new Set<number>();
  forEachDiagnostic(state, (d, dFrom, dTo) => {
    const code = (d as EditorDiagnostic).problem?.code;
    if (code == null || dFrom > to || dTo < from || seen.has(dFrom)) return;
    if (UNDEFINED_NAME.has(code)) fixes.push(...createForName(tree, state.doc, dFrom, unit));
    else if (MISSING_ATTRIBUTE.has(code)) fixes.push(...createForAttribute(tree, state.doc, dFrom, unit));
    else return;
    seen.add(dFrom);
  });
  return fixes;
}

function apply(view: EditorView, fix: CreateFix): void {
  const { from, text } = fix.insert;
  const body = from + fix.body;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: body, head: body + PASS.length },
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  view.focus();
}

/** Quick fixes of the unresolved references at `from..to` (the caret for ⌥↵). */
export function pythonCreateFixes(view: EditorView, from: number, to: number): ContributedIntention[] {
  if (docOf(view)?.uiMode !== "Python") return [];
  return createFixes(view.state, from, to).map((fix) => ({
    id: `python.create.${fix.kind}:${fix.name}`,
    label: label(fix),
    quickFix: true,
    run: () => apply(view, fix),
  }));
}
