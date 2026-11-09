import { LanguageSupport, LRLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { parseMixed, type Input, type NestedParse, type SyntaxNode, type SyntaxNodeRef } from "@lezer/common";
import { angular, angularLanguage } from "./index";

function nextCode(node: SyntaxNode): SyntaxNode | null {
  let next = node.nextSibling;
  while (next && (next.name === "BlockComment" || next.name === "LineComment")) next = next.nextSibling;
  return next;
}

function mixTemplate(node: SyntaxNodeRef, input: Input): NestedParse | null {
  if (node.name !== "Decorator") return null;
  const call = node.node.getChild("CallExpression");
  const callee = call?.firstChild;
  const name = callee?.name === "MemberExpression" ? callee.lastChild : callee;
  if (!name || !["VariableName", "PropertyName"].includes(name.name) || input.read(name.from, name.to) !== "Component")
    return null;
  const args = call?.getChild("ArgList");
  const metadata = args?.firstChild && nextCode(args.firstChild);
  if (metadata?.name !== "ObjectExpression") return null;
  for (const property of metadata.getChildren("Property")) {
    const key = property.firstChild;
    if (!key || !["template", "'template'", '"template"'].includes(input.read(key.from, key.to))) continue;
    const colon = nextCode(key);
    const value = colon?.name === ":" ? nextCode(colon) : null;
    if (!value || nextCode(value) || !["String", "TemplateString"].includes(value.name)) continue;
    // A dynamic JavaScript template retains its interpolation expressions.
    if (value.getChild("Interpolation")) continue;
    const quote = input.read(value.from, value.from + 1);
    const from = value.from + 1;
    const to = value.to - (!value.lastChild?.type.isError && input.read(value.to - 1, value.to) === quote ? 1 : 0);
    if (from < to) return { parser: angularLanguage.parser, overlay: [{ from, to }] };
  }
  return null;
}

const typescript = javascript({ typescript: true });

export function angularTypescript(): LanguageSupport {
  // Mount on the decorator so changing its name or metadata invalidates the template too.
  const language = (typescript.language as LRLanguage).configure(
    { wrap: parseMixed(mixTemplate) },
    "angular-typescript",
  );
  return new LanguageSupport(language, [typescript.support, angular().support]);
}
