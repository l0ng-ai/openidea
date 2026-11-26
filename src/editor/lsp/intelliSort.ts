/**
 * IntelliSort-style post-processing of Java imports after the language server's
 * organize-imports action: static imports first, and a wildcard once enough
 * classes of one package are used. Reads Editor › Code Style › Java › Imports.
 */
import { editorPrefs } from "@/platform/editorSettings";
import type { EditorView } from "@codemirror/view";

export interface IntelliSortOptions {
  keepStaticImportsFirst?: boolean;
  classCountToUseImportWithWildcard?: number;
}

const IMPORT_LINE = /^import\s+(static\s+)?([\w.*]+)\s*;\s*$/;

function targetOf(text: string) {
  const match = IMPORT_LINE.exec(text);
  if (!match) return null;
  const qualified = match[2]!;
  const wildcard = qualified.endsWith(".*");
  const name = wildcard ? qualified.slice(0, -2) : qualified;
  return {
    staticImport: !!match[1],
    wildcard,
    package: name.slice(0, name.lastIndexOf(".")),
    member: name.slice(name.lastIndexOf(".") + 1),
  };
}

/**
 * Transforms one contiguous block of Java import lines: repeated classes of a
 * package collapse to a wildcard at the threshold, and static imports can move
 * to the front. Non-import lines are ignored and keep their position.
 */
export function intelliSortBlock(block: string, options: IntelliSortOptions = {}): string {
  const threshold = Math.min(999, Math.max(1, Math.floor(options.classCountToUseImportWithWildcard ?? 5)));
  const source = block.split("\n");
  const targets = source.map(targetOf);
  const counts = new Map<string, number>();
  const wildcarded = new Set<string>();
  for (const target of targets) {
    if (!target) continue;
    if (target.wildcard) wildcarded.add(target.package);
    else if (!target.staticImport) counts.set(target.package, (counts.get(target.package) ?? 0) + 1);
  }
  const emitted = new Set(wildcarded);
  const lines: string[] = [];
  source.forEach((text, i) => {
    const target = targets[i];
    if (!target) {
      lines.push(text);
      return;
    }
    if (!target.staticImport && counts.get(target.package)! >= threshold && !emitted.has(target.package)) {
      emitted.add(target.package);
      lines.push("import " + target.package + ".*;");
      return;
    }
    if (!target.staticImport && emitted.has(target.package) && !target.wildcard) return;
    lines.push(text);
  });
  if (!options.keepStaticImportsFirst) return lines.join("\n");
  const statics = lines.filter((line) => targetOf(line)?.staticImport);
  const rest = lines.filter((line) => !targetOf(line)?.staticImport);
  return [...statics, ...rest].join("\n");
}

/** Rewrites the Java document's first import block in place when the style asks for it. */
export function applyJavaImportStyle(view: EditorView): void {
  const style = editorPrefs().codeStyle.languages.java;
  if (!style?.keepStaticImportsFirst && !style?.classCountToUseImportWithWildcard) return;
  const text = view.state.doc.toString();
  const lines = text.split("\n");
  const start = lines.findIndex((line) => IMPORT_LINE.test(line));
  if (start < 0) return;
  let end = start;
  while (end < lines.length && IMPORT_LINE.test(lines[end]!)) end++;
  const block = lines.slice(start, end).join("\n");
  const next = intelliSortBlock(block, style);
  if (next === block) return;
  let from = 0;
  for (let i = 0; i < start; i++) from += lines[i]!.length + 1;
  let to = from;
  for (let i = start; i < end; i++) to += lines[i]!.length + 1;
  view.dispatch({ changes: { from, to, insert: next } });
}
