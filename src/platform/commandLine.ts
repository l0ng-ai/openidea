/** Command-line helpers shared by the terminal and External Tools. */

/** Splits a command line (`/bin/zsh --login`, `-c "a b"`) into words, honouring quotes. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * Splits a command line into arguments: whitespace, '…' and "…" quoting, backslash escapes.
 * `windowsPaths`: a backslash only escapes a quote, so `C:\dir\app.jar` stays as typed.
 */
export function parseArgs(input: string, windowsPaths = false): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (
        ch === "\\" &&
        quote === '"' &&
        i + 1 < input.length &&
        (windowsPaths ? '"' : '"\\$`').includes(input[i + 1]!)
      )
        cur += input[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < input.length && (!windowsPaths || "\"'".includes(input[i + 1]!))) {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/**
 * The program and arguments of a shell command line (Settings › Terminal › Shell path). On
 * Windows a backslash is a path separator, and an unquoted path up to its `.exe` / `.cmd` /
 * `.bat` / `.com` is the program even with spaces in it (`C:\Program Files\…\pwsh.exe -NoLogo`).
 */
export function parseShellCommand(line: string, windows: boolean): string[] {
  const text = line.trim();
  if (windows && !/["']/.test(text)) {
    const end = /\.(?:exe|cmd|bat|com)(?=\s|$)/i.exec(text);
    if (end) {
      const stop = end.index + end[0].length;
      return [text.slice(0, stop), ...parseArgs(text.slice(stop), true)];
    }
  }
  return parseArgs(text, windows);
}

/** `path` as one word of a command line: quoted when it has whitespace. */
export function quotePath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** Inverse of `parseArgs` (quotes only when needed). */
export function formatArgs(args: readonly string[]): string {
  return args.map((a) => (a === "" ? "''" : /[\s'"\\$`]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(" ");
}
