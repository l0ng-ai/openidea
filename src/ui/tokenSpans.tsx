import type { ReactNode } from "react";

/** A syntax-coloured span of a text: `[from, to)` with its `tok-*` class names. */
export interface SourceToken {
  from: number;
  to: number;
  cls: string;
}

/**
 * `text` between `from` and `to` as spans with the tokens' `tok-*` classes
 * (styled in global.css); `key` prefixes the React keys.
 */
export function tokenSpans(
  text: string,
  from: number,
  to: number,
  tokens: readonly SourceToken[] | null,
  key = "",
): ReactNode[] {
  if (!tokens?.length) return [text.slice(from, to)];
  const out: ReactNode[] = [];
  let pos = from;
  for (const t of tokens) {
    if (t.to <= pos) continue;
    if (t.from >= to) break;
    const s = Math.max(t.from, pos);
    const e = Math.min(t.to, to);
    if (s > pos) out.push(text.slice(pos, s));
    out.push(
      <span key={`${key}${s}`} className={t.cls}>
        {text.slice(s, e)}
      </span>,
    );
    pos = e;
  }
  if (pos < to) out.push(text.slice(pos, to));
  return out;
}
