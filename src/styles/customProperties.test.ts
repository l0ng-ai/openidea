// @vitest-environment node
/**
 * A `var(--x)` with no fallback whose `--x` is declared nowhere resolves to the property's
 * initial value: a transparent background, inherited text. Nothing else catches it, so this
 * lists every such use.
 *
 * A name ending in `-` is the start of one assembled at runtime (`--diff-${kind}`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(e.name) ? [path] : [];
  });
}

it("every custom property read without a fallback is declared somewhere", () => {
  const declared = new Set<string>();
  const reads: { name: string; where: string }[] = [];
  for (const path of sources(SRC)) {
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)) declared.add(m[1]!);
    for (const m of text.matchAll(/["'`](--[\w-]+)/g)) declared.add(m[1]!); // setProperty("--x", …), { "--x": … }
    if (/\.test\.tsx?$/.test(path)) continue;
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      reads.push({ name: m[1]!, where: `${path.slice(SRC.length + 1)}:${line}` });
    }
  }
  const undeclared = reads.filter((r) => !declared.has(r.name) && !r.name.endsWith("-"));
  expect(undeclared.map((r) => `${r.name} at ${r.where}`)).toEqual([]);
});
