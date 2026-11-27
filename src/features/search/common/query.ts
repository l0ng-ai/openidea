/**
 * Query parsing for the choosers: `File.kt:42`, `File.kt:42:5`, pasted
 * absolute paths (`/root/src/File.kt`), `file://` URLs and Windows paths.
 * Lines / columns in the input are 1-based; the result is 0-based (IPC
 * coordinates).
 */
export interface ParsedQuery {
  /** Text to match (location suffix removed). */
  text: string;
  /** 0-based line, when a `:line` suffix was given. */
  line: number | null;
  /** 0-based column, when a `:line:col` suffix was given. */
  col: number | null;
}

const LOCATION = /^(.*?)(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\)):?$/;

export function parseLocationQuery(raw: string, root?: string | null): ParsedQuery {
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  if (/^file:\/\//i.test(text)) {
    text = text.replace(/^file:\/\//i, "");
    try {
      // Component decoding: `%23` in a file name is a `#`, not a fragment.
      text = decodeURIComponent(text);
    } catch {
      /* keep as is */
    }
    // `file:///C:/x` names `C:/x` on Windows.
    if (/^\/[a-zA-Z]:\//.test(text)) text = text.slice(1);
  }
  // Index paths are `/`-separated: separators may be mixed after a paste.
  if (text.includes("\\")) text = text.replace(/\\/g, "/");
  // `\\?\E:\x` (verbatim) and `\\.\E:\x` name `E:/x`.
  text = text.replace(/^\/\/[?.]\//, "");

  let line: number | null = null;
  let col: number | null = null;
  const m = LOCATION.exec(text);
  if (m && m[1] !== undefined && (m[2] ?? m[4])) {
    const l = Number(m[2] ?? m[4]);
    const c = m[3] ?? m[5];
    if (l > 0) {
      text = m[1];
      line = l - 1;
      col = c !== undefined && Number(c) > 0 ? Number(c) - 1 : null;
    }
  }

  if (root) {
    const rel = relativeToRoot(text, root.replace(/\/+$/, ""));
    if (rel !== null) text = rel;
  }
  return { text, line, col };
}

/**
 * `text` relative to the project `root`, or `null` when it is not below it. A drive-letter root
 * compares like Windows, where case does not matter (the backend upper-cases the drive letter).
 */
function relativeToRoot(text: string, root: string): string | null {
  if (text.length < root.length) return null;
  const head = text.slice(0, root.length);
  const same = /^[a-zA-Z]:\//.test(root) ? head.toLowerCase() === root.toLowerCase() : head === root;
  if (!same) return null;
  if (text.length === root.length) return "";
  return text[root.length] === "/" ? text.slice(root.length + 1) : null;
}

/** Selection for opening a parsed location; `undefined` when no line was given. */
export function selectionOf(q: Pick<ParsedQuery, "line" | "col">): { line: number; col: number } | undefined {
  return q.line === null ? undefined : { line: q.line, col: q.col ?? 0 };
}
