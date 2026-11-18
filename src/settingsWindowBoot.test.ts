// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname);
const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve(SRC, spec.slice(2)) : resolve(dirname(fromFile), spec);
  if (existsSync(base) && /\.(tsx?|css|json)$/.test(base)) return base;
  for (const ext of EXTS) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

describe("settingsWindowBoot static module graph", () => {
  it("stays isolated from Workbench, CodeMirror, xterm, and non-settings editor modules", () => {
    const root = resolve(SRC, "settingsWindowBoot.ts");
    const visited = new Set<string>();
    const forbidden: string[] = [];

    const walk = (file: string, chain: string[]) => {
      if (visited.has(file) || !/\.(ts|tsx)$/.test(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      for (const stmt of ast.statements) {
        if (
          (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) ||
          !stmt.moduleSpecifier ||
          !ts.isStringLiteral(stmt.moduleSpecifier)
        ) {
          continue;
        }
        // Type-only imports erase completely at build time.
        if (ts.isImportDeclaration(stmt) && stmt.importClause?.isTypeOnly) continue;
        if (ts.isExportDeclaration(stmt) && stmt.isTypeOnly) continue;

        const spec = stmt.moduleSpecifier.text;
        if (
          spec.startsWith("@codemirror/") ||
          spec.startsWith("@xterm/") ||
          spec === "mermaid" ||
          spec === "marked" ||
          spec.startsWith("@/editor")
        ) {
          forbidden.push([...chain, spec].join(" -> "));
          continue;
        }
        if (spec.startsWith(".") || spec.startsWith("@/")) {
          const target = resolveLocal(file, spec);
          if (!target) continue;
          const rel = target.slice(SRC.length + 1).replaceAll("\\", "/");
          if (rel === "workbench/Workbench.tsx" || rel.startsWith("editor/") || rel === "features/index.ts") {
            forbidden.push([...chain, rel].join(" -> "));
            continue;
          }
          walk(target, [...chain, rel]);
        }
      }
    };

    walk(root, ["settingsWindowBoot.ts"]);
    expect(visited.size).toBeGreaterThan(20);
    expect(forbidden).toEqual([]);
  });
});
