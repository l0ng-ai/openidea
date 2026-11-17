/**
 * Rails references navigated with Go to Declaration: method symbols in callbacks
 * (`before_action :load_user`, `if: :admin?`) and controller actions in `config/routes.rb`
 * (`to: "users#index"`, `resources :users`).
 */
import { pluralize } from "./conventions";

export type RailsReference =
  | { kind: "method"; name: string; from: number; to: number }
  | { kind: "action"; resource: string; action: string | null; from: number; to: number };

/** Class-level calls whose symbol arguments name methods of the class. */
const CALLBACK =
  /^\s*(?:(?:prepend|append|skip)_)?(?:before|after|around)_[a-z_]+\b|^\s*(?:helper_method|validate|rescue_from|after_commit|after_rollback)\b/;
const SYMBOL = /(^|[^\w:]):([A-Za-z_]\w*[!?]?)/g;
const ACTION_STRING = /(["'])((?:[a-z0-9_]+\/)*[a-z0-9_]+)#([a-z_]\w*[!?]?)\1/g;
const RESOURCES = /^\s*(resources?)\s+((?::[a-z_]\w*\s*,\s*)*:[a-z_]\w*)/;

function lineAt(text: string, offset: number): { line: string; start: number } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const end = text.indexOf("\n", offset);
  return { line: text.slice(start, end < 0 ? text.length : end), start };
}

export function railsReferenceAt(text: string, offset: number, routes: boolean): RailsReference | null {
  const { line, start } = lineAt(text, offset);
  const col = offset - start;
  if (routes) {
    for (const m of line.matchAll(ACTION_STRING)) {
      if (col > m.index && col < m.index + m[0].length - 1)
        return {
          kind: "action",
          resource: m[2]!,
          action: m[3]!,
          from: start + m.index + 1,
          to: start + m.index + m[0].length - 1,
        };
    }
    const r = RESOURCES.exec(line);
    if (r) {
      for (const s of r[2]!.matchAll(/:([a-z_]\w*)/g)) {
        const from = r.index + r[0].length - r[2]!.length + s.index;
        if (col >= from && col < from + s[0].length)
          return {
            kind: "action",
            resource: r[1] === "resource" ? pluralize(s[1]!) : s[1]!,
            action: null,
            from: start + from + 1,
            to: start + from + s[0].length,
          };
      }
    }
    return null;
  }
  if (!CALLBACK.test(line)) return null;
  for (const m of line.matchAll(SYMBOL)) {
    const at = m.index + m[1]!.length;
    if (col >= at && col < m.index + m[0].length)
      return { kind: "method", name: m[2]!, from: start + at + 1, to: start + m.index + m[0].length };
  }
  return null;
}
