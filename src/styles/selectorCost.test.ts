// @vitest-environment node
/**
 * Selectors that make Chromium restyle whole subtrees on unrelated DOM changes. Blink checks a
 * selector whose last part is universal (`*`, or only pseudo-classes) against every element, so:
 *
 * - `x > * + *` / `x ~ *` flags every parent as having children styled by their siblings, and any
 *   insertion then restyles the next sibling's whole subtree (an editor scroll inserts lines and
 *   gutters every frame);
 * - `:focus *` / `:hover ::selection` makes every focus or hover change restyle the subtree of the
 *   element it happens on, wherever that element is;
 * - `x:not(:focus-within) .y` makes WebKit restyle the whole window on every focus change (write the
 *   default style for `x .y` and override it with `x:focus-within .y`).
 *
 * Name the element instead (`x > :not(:first-child)`, `x > .item + .item`, `x:focus .label`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return stylesheets(path);
    return e.name.endsWith(".css") ? [path] : [];
  });
}

/** A compound selector with no type, class, id or attribute: `*`, `:not(…)`, `::selection`. */
const UNIVERSAL = String.raw`(?:\*|(?=:))(?::{1,2}[\w-]+(?:\([^)]*\))?)*`;
const SIBLING = new RegExp(String.raw`[+~]\s*${UNIVERSAL}\s*$`);
const STATE_DESCENDANT = new RegExp(
  String.raw`:(?:focus|focus-within|focus-visible|hover|active)[^\s>+~]*[\s>]+${UNIVERSAL}\s*$`,
);
const NEGATED_STATE = /:not\(:(?:focus|focus-within|focus-visible|hover|active)\)[^\s>+~]*[\s>+~]/;

it("no selector restyles whole subtrees on sibling insertions or focus changes", () => {
  const costly: string[] = [];
  for (const path of stylesheets(SRC)) {
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const prelude of css.matchAll(/([^{};]+)\{/g)) {
      const text = prelude[1]!.trim();
      if (text.startsWith("@")) continue;
      for (const selector of text.split(/,(?![^(]*\))/)) {
        const s = selector.trim().replace(/:global\(([^)]*)\)/g, "$1");
        // Combinators inside `:has(…)` relate other elements, not this one's ancestors.
        const outer = s.replace(/:has\((?:[^()]|\([^()]*\))*\)/g, "");
        if (SIBLING.test(s) || STATE_DESCENDANT.test(s) || NEGATED_STATE.test(outer))
          costly.push(`${path.slice(SRC.length + 1)}: ${s}`);
      }
    }
  }
  expect(costly).toEqual([]);
});
