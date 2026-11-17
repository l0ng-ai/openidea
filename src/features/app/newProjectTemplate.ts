/**
 * Field defaults of File › New Project generators: `{{field}}` / `{{field|filter|…}}`
 * over the fields before them, rendered as `crates/ide-scaffold/src/template.rs` does.
 */
import type { Field } from "@/platform/ipc";

export type Values = Record<string, string>;

function words(s: string): string[] {
  const out: string[] = [];
  let word = "";
  let prevLower = false;
  for (const c of s) {
    if (!/[\p{L}\p{N}]/u.test(c)) {
      if (word) out.push(word);
      word = "";
      prevLower = false;
      continue;
    }
    const upper = c !== c.toLowerCase();
    if (upper && prevLower && word) {
      out.push(word);
      word = "";
    }
    prevLower = c !== c.toUpperCase() || /\d/.test(c);
    word += c;
  }
  if (word) out.push(word);
  return out;
}

function apply(filter: string, value: string): string {
  switch (filter) {
    case "path":
      return value.replaceAll(".", "/");
    case "ident": {
      const s = value.toLowerCase().replace(/[^a-z0-9_]/g, "");
      return /^\d/.test(s) ? `_${s}` : s;
    }
    case "kebab":
      return words(value)
        .map((w) => w.toLowerCase())
        .join("-");
    case "snake":
      return words(value)
        .map((w) => w.toLowerCase())
        .join("_");
    case "pascal":
      return words(value)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("");
    case "lower":
      return value.toLowerCase();
    case "json":
      return JSON.stringify(value).slice(1, -1);
    default:
      return value;
  }
}

export function render(template: string, values: Values): string {
  return template.replace(/\{\{([^}]*)\}\}/g, (_, expr: string) => {
    const [name = "", ...filters] = expr.split("|").map((p) => p.trim());
    return filters.reduce((v, f) => apply(f, v), values[name] ?? "");
  });
}

/** `edited` plus every field's rendered default it lacks, `name` included. */
export function effectiveValues(fields: readonly Field[], name: string, edited: Values): Values {
  const out: Values = { name: name.trim(), ...edited };
  for (const f of fields) if (!(f.id in out)) out[f.id] = render(f.default, out);
  return out;
}

export function isVisible(field: Field, values: Values): boolean {
  return Object.entries(field.visible).every(([id, allowed]) => allowed.includes(values[id] ?? ""));
}

/** Why `value` is not acceptable for `field`, or null. */
export function fieldError(field: Field, value: string): string | null {
  if (field.kind.type !== "text" || !field.kind.pattern) return null;
  try {
    return new RegExp(field.kind.pattern, "u").test(value) ? null : "Invalid value";
  } catch {
    return null;
  }
}
