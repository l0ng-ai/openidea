/** Just enough Python scanning for Django files: strings, comments and bracket nesting. */

/**
 * `src` with comments blanked (`code`) and also string contents blanked (`bare`), same length:
 * brackets and names found in `bare` are code, never text in a string or a comment.
 */
export function masks(src: string): { code: string; bare: string; inString: boolean } {
  let code = "";
  let bare = "";
  let inString = false;
  for (let i = 0; i < src.length;) {
    const c = src[i]!;
    if (c === "#") {
      const end = src.indexOf("\n", i);
      const n = (end < 0 ? src.length : end) - i;
      code += " ".repeat(n);
      bare += " ".repeat(n);
      i += n;
    } else if (c === '"' || c === "'") {
      const quote = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j) && (quote.length === 3 || src[j] !== "\n"))
        j += src[j] === "\\" ? 2 : 1;
      inString = j >= src.length;
      j = Math.min(src.length, j + quote.length);
      code += src.slice(i, j);
      bare += quote + src.slice(i + quote.length, j - quote.length).replace(/[^\n]/g, " ") + quote;
      i = j;
    } else {
      code += c;
      bare += c;
      i++;
    }
  }
  return { code, bare: bare.slice(0, src.length), inString };
}

export interface PyArg {
  /** The keyword of `key=value`, else null. */
  key: string | null;
  /** The value's source text (comments blanked). */
  value: string;
  /** Offset of `value` in the source. */
  from: number;
}

export interface PyCall {
  name: string;
  /** Offset of the name. */
  from: number;
  args: PyArg[];
}

/** The top-level arguments of the call whose `(` is at `open` (offsets into the masked source). */
export function callArgs(code: string, bare: string, open: number): PyArg[] {
  const args: PyArg[] = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number) => {
    const raw = code.slice(start, end);
    const kw = /^(\s*)(\w+)\s*=(?!=)\s*/.exec(raw);
    const lead = kw ? kw[0].length : raw.length - raw.trimStart().length;
    const value = raw.slice(lead).trimEnd();
    if (value) args.push({ key: kw ? kw[2]! : null, value, from: start + lead });
  };
  for (let i = open + 1; i < bare.length; i++) {
    const c = bare[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) {
        push(i);
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  return args;
}

/** Calls of `names` (`path`, `include`…) with their top-level arguments. */
export function pyCalls(src: string, names: readonly string[]): PyCall[] {
  const { code, bare } = masks(src);
  const head = new RegExp(String.raw`(?:^|[^\w.])(${names.join("|")})\s*\(`, "g");
  // The match starts with the character before the name, when there is one.
  return [...bare.matchAll(head)].map((m) => ({
    name: m[1]!,
    from: m.index + m[0].indexOf(m[1]!),
    args: callArgs(code, bare, m.index + m[0].length - 1),
  }));
}

/** The text of a plain string literal (`"x"`, `r'x'`), else null. */
export function pyString(value: string): string | null {
  return /^[rRuU]?(["'])([^"'\\\n]*)\1$/.exec(value.trim())?.[2] ?? null;
}

/** 0-based line and UTF-16 column of `offset` in `text`. */
export function position(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let start = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: offset - start };
}
