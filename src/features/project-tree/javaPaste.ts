// IDEA's Java file paste: Java code pasted into a folder of the Project view becomes
// `<Class>.java`, declaring the folder's package.
import { javaLanguage } from "@codemirror/lang-java";
import type { SyntaxNode } from "@lezer/common";
import { rootFor, type RootFolder } from "@/platform/languageSettings";
import { isJvmSourcePackage } from "@/ui/folderPresentation";

const TYPE_DECLARATIONS = new Set([
  "ClassDeclaration",
  "InterfaceDeclaration",
  "EnumDeclaration",
  "RecordDeclaration",
  "AnnotationTypeDeclaration",
]);

const typeName = (text: string, declaration: SyntaxNode) => {
  const name = declaration.getChild("Definition") ?? declaration.getChild("Identifier");
  return name ? text.slice(name.from, name.to) : null;
};

const isPublic = (text: string, declaration: SyntaxNode) => {
  const modifiers = declaration.getChild("Modifiers");
  return !!modifiers && /(^|\s)public(\s|$)/.test(text.slice(modifiers.from, modifiers.to));
};

/**
 * The class pasted Java code is named after: its first public top-level type, else its first
 * top-level type; null when the text declares none (a statement, plain prose).
 */
export function pastedJavaClass(text: string): string | null {
  if (!/\b(class|interface|enum|record)\b/.test(text)) return null;
  const top = javaLanguage.parser.parse(text).topNode;
  let first: string | null = null;
  for (let node = top.firstChild; node; node = node.nextSibling) {
    if (!TYPE_DECLARATIONS.has(node.name)) continue;
    const name = typeName(text, node);
    if (!name) continue;
    if (isPublic(text, node)) return name;
    first ??= name;
  }
  return first;
}

/**
 * The package of the project-relative folder `rel`: its path below the Java source or test root
 * it is in; null outside one, where a pasted file keeps the package it declares.
 */
export function javaPackageAt(rel: string, roots: readonly RootFolder[]): string | null {
  if (!isJvmSourcePackage(rel, roots)) return null;
  const root = rootFor(roots, rel)!;
  const below = root.path ? rel.slice(root.path.length).replace(/^\/+/, "") : rel;
  return below.split("/").filter(Boolean).join(".");
}

/**
 * `text` declaring `pkg`: its package statement replaced, or one added in front. Unchanged for the
 * default package (`""`), as in IDEA, which leaves the statement of code pasted into a source root.
 */
export function withJavaPackage(text: string, pkg: string): string {
  if (!pkg) return text;
  const declaration = javaLanguage.parser.parse(text).topNode.getChild("PackageDeclaration");
  if (!declaration) return `package ${pkg};\n\n${text}`;
  const name = declaration.getChild("ScopedIdentifier") ?? declaration.getChild("Identifier");
  if (name && text.slice(name.from, name.to).replace(/\s+/g, "") === pkg) return text;
  return `${text.slice(0, declaration.from)}package ${pkg};${text.slice(declaration.to)}`;
}
