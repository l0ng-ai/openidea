/**
 * The imports an override copied from a base class needs: names its signature uses that the
 * current file does not bind, imported the way the base class's file binds them.
 */

/** How a module binds a top-level name: an import statement (`from m import x`, `import m`) or its own definition. */
export type Binding = { import: string } | { defined: true };

/** Top-level names `lines` bind (imports, classes, functions, assignments). */
export function topLevelBindings(lines: readonly string[]): Map<string, Binding> {
  const out = new Map<string, Binding>();
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    if (/^\s/.test(text)) continue;
    // `from m import a, \` + `b`: one statement.
    while (text.trimEnd().endsWith("\\") && i + 1 < lines.length)
      text = text.trimEnd().slice(0, -1) + " " + lines[++i]!;
    const from = /^from\s+(\S+)\s+import\s+(.*)$/.exec(text);
    if (from) {
      let names = from[2]!;
      // `from m import (a,\n    b)`.
      if (names.includes("(")) while (!names.includes(")") && i + 1 < lines.length) names += " " + lines[++i]!;
      for (const part of names.replace(/[()]/g, "").replace(/#.*/, "").split(",")) {
        const m = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) out.set(m[2] ?? m[1]!, { import: `from ${from[1]} import ${m[1]}${m[2] ? ` as ${m[2]}` : ""}` });
      }
      continue;
    }
    const imp = /^import\s+(.*)$/.exec(text);
    if (imp) {
      for (const part of imp[1]!.replace(/#.*/, "").split(",")) {
        const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (m) out.set(m[2] ?? m[1]!.split(".")[0]!, { import: `import ${m[1]}${m[2] ? ` as ${m[2]}` : ""}` });
      }
      continue;
    }
    text = text.replace(/^async\s+/, "");
    const def = /^(?:class|def|type)\s+(\w+)|^(\w+)\s*(?::[^=]*)?=(?!=)|^(\w+)\s*:/.exec(text);
    const name = def && (def[1] ?? def[2] ?? def[3]);
    if (name && !out.has(name)) out.set(name, { defined: true });
  }
  return out;
}

/** The module `name` (a base class as written, `Base` or `mod.Base`) is imported from in `lines`; null if it is not imported. */
export function importedFrom(lines: readonly string[], name: string): string | null {
  const head = name.split(".")[0]!;
  const binding = topLevelBindings(lines).get(head);
  if (!binding || !("import" in binding)) return null;
  const from = /^from\s+(\S+)\s+import\s+(\w+)/.exec(binding.import);
  if (from)
    return name.includes(".") ? `${from[1]}.${from[2]}${name.slice(head.length, name.lastIndexOf("."))}` : from[1]!;
  const imp = /^import\s+([\w.]+)/.exec(binding.import)!;
  return name.includes(".") ? imp[1]! + name.slice(head.length, name.lastIndexOf(".")) : null;
}

/**
 * Import statements for `names` that `current` does not bind and the base file binds
 * (`base`); `module` is where the base file's own definitions are imported from ("" for the
 * current file, null when unknown).
 */
export function neededImports(
  names: readonly string[],
  current: ReadonlyMap<string, Binding>,
  base: ReadonlyMap<string, Binding>,
  module: string | null,
): string[] {
  const out = new Set<string>();
  for (const name of names) {
    if (current.has(name)) continue;
    const binding = base.get(name);
    if (!binding) continue;
    if ("import" in binding) {
      // The base file's relative imports mean something else here.
      if (module === "" || !/^from\s+\./.test(binding.import)) out.add(binding.import);
    } else if (module) out.add(`from ${module} import ${name}`);
  }
  return [...out];
}

/** 0-based line before which new imports go: after the file's last top-level import, else before its first statement. */
export function importLine(lines: readonly string[]): number {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (/^(class|def|async\s+def|@)/.test(text)) break;
    if (/^(import|from)\s/.test(text)) {
      last = i;
      if (text.includes("(") && !text.includes(")"))
        while (last + 1 < lines.length && !lines[last]!.includes(")")) last++;
      // `from m import a, \` + `b`: up to its last line.
      while (lines[last]!.trimEnd().endsWith("\\") && last + 1 < lines.length) last++;
      i = last;
    }
  }
  if (last >= 0) return last + 1;
  let i = 0;
  // A module docstring and leading comments stay first.
  if (/^[rRuUbB]?("""|''')/.test(lines[0] ?? "")) {
    const quote = /("""|''')/.exec(lines[0]!)![1]!;
    i =
      lines[0]!.indexOf(quote, lines[0]!.indexOf(quote) + 3) >= 0
        ? 1
        : lines.findIndex((l, n) => n > 0 && l.includes(quote)) + 1;
  }
  while (i < lines.length && /^\s*(#.*)?$/.test(lines[i]!)) i++;
  return i;
}

/**
 * Where `statements` go in `lines`: names imported `from` a module the file already imports from
 * on one line are added to that line (0-based number, text appended); the rest are new lines,
 * one per module, inserted at `importLine`.
 */
export function placeImports(
  lines: readonly string[],
  statements: readonly string[],
): { appended: Map<number, string>; added: string[] } {
  const appended = new Map<number, string>();
  const grouped = new Map<string, string[]>();
  const added: string[] = [];
  for (const statement of statements) {
    const from = /^from\s+(\S+)\s+import\s+(.+)$/.exec(statement);
    if (!from) {
      added.push(statement);
      continue;
    }
    const existing = lines.findIndex((l) => l.startsWith(`from ${from[1]} import `) && !/[(#\\]/.test(l));
    if (existing >= 0) appended.set(existing, `${appended.get(existing) ?? ""}, ${from[2]}`);
    else grouped.set(from[1]!, [...(grouped.get(from[1]!) ?? []), from[2]!]);
  }
  for (const [module, names] of grouped) added.push(`from ${module} import ${names.join(", ")}`);
  return { appended, added };
}
