import type { RunTarget } from "./targets";

/** Mask comments/literals without changing UTF-16 offsets or line breaks. */
export function csharpTargets(text: string): RunTarget[] {
  const code = text.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|@"(?:""|[^"])*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (value) => value.replace(/[^\r\n]/g, " "),
  );
  const tokens =
    /\bnamespace\s+([\w.]+)\s*([;{])|\b(?:class|record|struct)\s+(\w+)[^;{}]*\{|\[([^\]]*)\]|\b(\w+)\s*\([^;{}]*\)\s*(?=\{|=>)|[{};]/g;
  const scopes: Array<{ name: string; depth: number; line: number; kind: "namespace" | "class" }> = [];
  const out: RunTarget[] = [];
  const suites = new Set<string>();
  let depth = 0;
  let line = 0;
  let offset = 0;
  let fileNamespace = "";
  let test = false;
  for (const match of code.matchAll(tokens)) {
    const value = match[0];
    while (offset < match.index) {
      if (code.charCodeAt(offset) === 10) line++;
      offset++;
    }
    if (match[1]) {
      if (match[2] === ";") fileNamespace = match[1];
      else scopes.push({ name: match[1], depth: ++depth, line, kind: "namespace" });
    } else if (match[3]) {
      scopes.push({ name: match[3], depth: ++depth, line, kind: "class" });
      test = false;
    } else if (match[4] !== undefined) {
      test ||=
        /(?:^|[.,\s])(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)(?:Attribute)?\b/.test(
          match[4],
        );
    } else if (match[5]) {
      if (test && scopes.some((s) => s.kind === "class")) {
        const className = [
          fileNamespace,
          ...scopes.filter((s) => s.kind === "namespace").map((s) => s.name),
          scopes
            .filter((s) => s.kind === "class")
            .map((s) => s.name)
            .join("+"),
        ]
          .filter(Boolean)
          .join(".");
        const owner = scopes.filter((s) => s.kind === "class").at(-1)!;
        if (!suites.has(className)) {
          suites.add(className);
          out.push({ line: owner.line, kind: "suite", name: owner.name, path: [className] });
        }
        out.push({ line, kind: "test", name: match[5], path: [className, match[5]] });
      }
      test = false;
    } else if (value === "{") depth++;
    else if (value === "}") {
      depth--;
      while (scopes.length && scopes.at(-1)!.depth > depth) scopes.pop();
      test = false;
    } else test = false;
  }
  return out;
}
