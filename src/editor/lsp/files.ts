/** Reading other files' text for previews (definitions, choosers), and backend documents for them. */
import { editorsFor } from "@/editor/api";
import { call, commands, isTauri } from "@/platform/ipc";
import { isVirtualUri, virtualDocument } from "@/platform/virtualDocs";

/**
 * Lines of `path`: from an open editor when there is one (includes unsaved
 * edits), otherwise a read-only backend read.
 */
export async function readFileLines(path: string): Promise<string[] | null> {
  const open = editorsFor(path)[0];
  if (open) return open.view.state.doc.toJSON();
  if (!isTauri()) return null;
  if (isVirtualUri(path))
    return virtualDocument(path).then(
      (d) => d.text.split(/\r\n?|\n/),
      () => null,
    );
  try {
    const text = await call(commands.fsReadText(path));
    return text.split(/\r\n?|\n/);
  } catch {
    return null;
  }
}

/** Reads several files with bounded concurrency; missing files map to `null`. */
export async function readManyFileLines(
  paths: readonly string[],
  concurrency = 4,
): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const queue = [...new Set(paths)];
  const worker = async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) out.set(p, await readFileLines(p));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * Runs `fn` with a backend document id for `path` (an open editor's when there
 * is one; otherwise opened for the call only, the backend ref-counts it).
 */
export async function withDocument<T>(path: string, fn: (doc: number) => Promise<T>): Promise<T> {
  const open = editorsFor(path)[0];
  if (open) return fn(open.ctx.doc);
  const info = await call(isVirtualUri(path) ? commands.docOpenVirtual(path) : commands.docOpen(path));
  try {
    return await fn(info.id);
  } finally {
    void commands.docClose(info.id);
  }
}

/** Longest literal label before it is shortened with an ellipsis. */
const MAX_LITERAL_LABEL = 60;

/**
 * Display name of a navigation target starting at `col` of `line`: the string
 * literal when the target is one (a Spring `@Value("${key}")` consumer, a
 * configuration key in quotes), else the identifier there; null when neither.
 */
export function targetLabel(line: string, col: number): string | null {
  const quote = line[col];
  if (quote === '"' || quote === "'" || quote === "`") {
    let end = col + 1;
    while (end < line.length && line[end] !== quote) end += line[end] === "\\" ? 2 : 1;
    const literal = line.slice(col, Math.min(end + 1, line.length));
    if (literal.length > 2)
      return literal.length > MAX_LITERAL_LABEL ? `${literal.slice(0, MAX_LITERAL_LABEL - 1)}…` : literal;
  }
  return identifierAt(line, col);
}

/** The identifier at (or starting right after) `col` of `line`; null when there is none. */
function identifierAt(line: string, col: number): string | null {
  const re = /[\p{L}\p{N}_$]+/gu;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const end = m.index + m[0].length;
    if (end < col) continue;
    if (m.index > col + 1) return null;
    return /^\p{N}/u.test(m[0]) ? null : m[0];
  }
  return null;
}
