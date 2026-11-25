// IDEA's Copy Class: a copied `.java` file under a new name declares its type under that name,
// and the copy's own references to the type (constructors, `Foo.this`, `new Foo()`) follow it.
import { javaLanguage } from "@codemirror/lang-java";
import type { SyntaxNode } from "@lezer/common";
import { call, commands } from "@/platform/ipc";
import { nameOf, splitExtension } from "./paths";

const JAVA_IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

const TYPE_DECLARATIONS = new Set([
  "ClassDeclaration",
  "InterfaceDeclaration",
  "EnumDeclaration",
  "RecordDeclaration",
  "AnnotationTypeDeclaration",
]);

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** The type a copy named `to` renames, or null when the copy is not a Java type under a new name. */
export function copiedJavaType(from: string, to: string): { oldName: string; newName: string } | null {
  const [oldName, oldExt] = splitExtension(from);
  const [newName, newExt] = splitExtension(to);
  if (oldExt !== ".java" || newExt !== ".java" || oldName === newName) return null;
  return JAVA_IDENTIFIER.test(oldName) && JAVA_IDENTIFIER.test(newName) ? { oldName, newName } : null;
}

function isTypeDefinition(node: SyntaxNode): boolean {
  const parent = node.parent;
  return !!parent && (TYPE_DECLARATIONS.has(parent.name) || parent.name === "ConstructorDeclaration");
}

/**
 * Renames the top-level type `oldName` to `newName` in `text`: its declaration, constructors and
 * references, but not strings, comments or members that happen to share the name. Empty when the
 * file declares no top-level type of that name.
 */
export function renameJavaTypeEdits(text: string, oldName: string, newName: string): TextEdit[] {
  const tree = javaLanguage.parser.parse(text);
  const declared = [...TYPE_DECLARATIONS]
    .flatMap((name) => tree.topNode.getChildren(name).flatMap((d) => d.getChildren("Definition")))
    .some((d) => text.slice(d.from, d.to) === oldName);
  if (!declared) return [];
  const edits: TextEdit[] = [];
  tree.iterate({
    enter(ref) {
      if (ref.to - ref.from !== oldName.length || text.slice(ref.from, ref.to) !== oldName) return;
      const node = ref.node;
      const renamed =
        ref.name === "TypeName" ||
        (ref.name === "Definition" && isTypeDefinition(node)) ||
        // A qualifier: `Foo.CONSTANT`, `Foo.this`, `Foo.of()`.
        (ref.name === "Identifier" && /^\s*(\.|::)/.test(text.slice(ref.to, ref.to + 8)));
      if (renamed) edits.push({ from: ref.from, to: ref.to, insert: newName });
    },
  });
  return edits;
}

/** After copying `source` to `copy`, renames the copied type to the copy's name. */
export async function renameCopiedJavaType(source: string, copy: string): Promise<void> {
  const names = copiedJavaType(nameOf(source), nameOf(copy));
  if (!names) return;
  const info = await call(commands.docOpen(copy));
  try {
    const edits = renameJavaTypeEdits(info.text, names.oldName, names.newName);
    if (!edits.length) return;
    await call(commands.docEdit(info.id, info.version, { changes: edits }));
    await call(commands.docSave(info.id));
  } finally {
    void commands.docClose(info.id);
  }
}
