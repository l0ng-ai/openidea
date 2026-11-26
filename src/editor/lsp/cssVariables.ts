/**
 * CSS custom properties from the whole project: `var(--…)` completion (the document's own
 * declarations first, values in the type column, a swatch for colors) and the hover over
 * `var(--x)`. The language server only sees the open stylesheet; declarations come from
 * the backend (`web_css_variables`: the document's text plus the project index).
 */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { whenSynced } from "@/editor/api";
import { call, commands, isTauri, type CssVariable, type Hover } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { lspDoc } from "./lsp";
import { offsetToPos } from "./positions";

export const STYLESHEETS = new Set(["css", "scss", "less"]);

/** The custom property name typed so far inside `var(` at the end of `before`, or null outside one. */
export function cssVariablePrefix(before: string): string | null {
  const m = /\bvar\(\s*(-[\w-]*)?$/.exec(before);
  return m ? (m[1] ?? "") : null;
}

/** The `--name` of a `var(--name)` on `line` that covers column `col`. */
export function cssVariableAt(line: string, col: number): { name: string; from: number; to: number } | null {
  for (const m of line.matchAll(/\bvar\(\s*(--[\w-]+)/g)) {
    const to = m.index + m[0].length;
    const from = to - m[1]!.length;
    if (col >= from && col <= to) return { name: m[1]!, from, to };
  }
  return null;
}

const NOT_SWATCH = /^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/i;

/** The value as a CSS color, when the browser parses it as one (not `var(…)`: that is always "valid"). */
export function swatchColor(value: string | null): string | null {
  const color = value?.replace(/\s*!important$/i, "");
  if (!color || /var\(/i.test(color) || NOT_SWATCH.test(color)) return null;
  return typeof CSS !== "undefined" && CSS.supports?.("color", color) ? color : null;
}

/** An option with its value in the type column and, for a color, a swatch for its icon. */
export type VariableOption = Completion & { typeText?: string; swatch?: string };

/** A completion option per name, the first declaration winning (the backend lists the document's own first). */
export function variableOptions(vars: readonly CssVariable[], path: string): VariableOption[] {
  const seen = new Set<string>();
  const options: VariableOption[] = [];
  for (const v of vars) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    const swatch = swatchColor(v.value);
    options.push({
      label: v.name,
      type: "variable",
      boost: v.location.path === path ? 10 : 0,
      ...(v.value ? { typeText: v.value } : {}),
      ...(swatch ? { swatch } : {}),
    });
  }
  return options;
}

async function variablesOf(doc: number, view: EditorView | undefined): Promise<CssVariable[]> {
  if (view) await whenSynced(view);
  return call(commands.webCssVariables(doc)).catch(() => []);
}

export async function cssVariableSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const doc = ctx.state.facet(lspDoc);
  if (!doc || doc.virtual || doc.readOnly || !STYLESHEETS.has(doc.language) || !isTauri()) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const prefix = cssVariablePrefix(line.text.slice(0, ctx.pos - line.from));
  if (prefix === null) return null;
  const vars = await variablesOf(doc.doc, ctx.view);
  if (ctx.aborted || !vars.length) return null;
  return { from: ctx.pos - prefix.length, options: variableOptions(vars, doc.path), validFor: /^-[\w-]*$|^$/ };
}

/** Hover over `var(--x)`: each declaration with its value and file. */
export function variableHoverMarkdown(name: string, vars: readonly CssVariable[]): string | null {
  const lines = vars
    .filter((v) => v.name === name)
    .map((v) => `${name}: ${v.value ?? ""}; /* ${basename(v.location.path)}:${v.location.range.start.line + 1} */`);
  return lines.length ? "```css\n" + lines.join("\n") + "\n```" : null;
}

export async function cssVariableHover(view: EditorView, pos: number): Promise<Hover | null> {
  const doc = view.state.facet(lspDoc);
  if (!doc || doc.virtual || !STYLESHEETS.has(doc.language) || !isTauri()) return null;
  const line = view.state.doc.lineAt(pos);
  const at = cssVariableAt(line.text, pos - line.from);
  if (!at) return null;
  const value = variableHoverMarkdown(at.name, await variablesOf(doc.doc, view));
  if (!value) return null;
  const range = {
    start: offsetToPos(view.state.doc, line.from + at.from),
    end: offsetToPos(view.state.doc, line.from + at.to),
  };
  return { contents: { kind: "markdown", value }, range };
}
