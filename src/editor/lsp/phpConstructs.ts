import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

const CONSTRUCTS: Readonly<Record<string, { signature: string; description: string }>> = {
  empty: {
    signature: "empty(mixed $var): bool",
    description:
      "Returns true when the value is falsey or the variable does not exist. Checking an undefined variable does not emit a warning.",
  },
  isset: {
    signature: "isset(mixed $var, mixed ...$vars): bool",
    description:
      "Returns true only when every supplied variable exists and is not null. Checks stop at the first unset or null variable.",
  },
};

export function phpConstructDocumentation(language: string | null, name: string): string | null {
  if (language?.toLowerCase() !== "php") return null;
  const key = name.toLowerCase();
  const entry = Object.hasOwn(CONSTRUCTS, key) ? CONSTRUCTS[key] : undefined;
  if (!entry) return null;
  return [
    "```php\n" + entry.signature + "\n```",
    entry.description,
    "PHP language construct; there is no source declaration to navigate to.",
    `[PHP manual](https://www.php.net/manual/en/function.${key}.php)`,
  ].join("\n\n");
}

/** Only an unqualified call, never a method, variable, string, comment or HTML text. */
export function phpConstructAt(state: EditorState, pos: number, language: string | null) {
  if (language?.toLowerCase() !== "php") return null;
  for (const side of [-1, 1] as const) {
    const node = syntaxTree(state).resolveInner(pos, side);
    if (node.name !== "Name" || node.parent?.name !== "CallExpression" || node.parent.from !== node.from) continue;
    const markdown = phpConstructDocumentation(language, state.sliceDoc(node.from, node.to));
    if (markdown) return { from: node.from, to: node.to, markdown };
  }
  return null;
}
