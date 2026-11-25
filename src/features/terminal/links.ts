/** Link detection in terminal lines: URLs and `path:line[:col]` file locations. */

export type TerminalLink =
  | { kind: "url"; start: number; end: number; text: string; url: string }
  | { kind: "file"; start: number; end: number; text: string; path: string; line?: number; col?: number };

export interface PathCandidate {
  start: number;
  end: number;
  text: string;
  path: string;
}

const URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`]+/g;

// `src/main.rs:10:5`, `./a/b.ts:3`, `/abs/x.py:12`, `foo.go(12,3)`, `Foo.kt:22`,
// and Windows paths: `src\main.rs:10:5`, `.\main.go:5:2`, `C:\p\Program.cs(10,5)`.
const FILE_RE =
  /((?:[A-Za-z]:[\\/]|~|\.{1,2})?[\\/]?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\))/g;

/** Strips trailing punctuation that is almost never part of a URL (keeps balanced parens). */
export function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    if (".,;:!?'\"".includes(last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === ")" || last === "]") {
      const open = last === ")" ? "(" : "[";
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    return out;
  }
}

/**
 * A `file://` URL (compiler output such as Kotlin's `file:///src/A.kt:15:56`) as a file location:
 * it opens in the editor, on the machine the terminal runs on, like a plain path.
 */
function fileUrlTarget(url: string): { path: string; line?: number; col?: number } | null {
  const m = /^file:\/\/[^/]*(\/.*?)(?::(\d+)(?::(\d+))?)?$/i.exec(url);
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  // `file:///C:/x` is the Windows path `C:/x`.
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  return { path, line: m[2] ? Number(m[2]) : undefined, col: m[3] ? Number(m[3]) : undefined };
}

export function findTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const end = m.index + url.length;
    const file = fileUrlTarget(url);
    links.push(
      file
        ? { kind: "file", start: m.index, end, text: url, ...file }
        : { kind: "url", start: m.index, end, text: url, url },
    );
  }
  const overlaps = (s: number, e: number) => links.some((l) => s < l.end && e > l.start);
  for (const m of text.matchAll(FILE_RE)) {
    const start = m.index;
    if (start > 0 && /[\w/.~-]/.test(text[start - 1]!)) continue;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    const line = Number(m[2] ?? m[4]);
    const colRaw = m[3] ?? m[5];
    links.push({
      kind: "file",
      start,
      end,
      text: m[0],
      path: m[1]!,
      line: Number.isFinite(line) ? line : undefined,
      col: colRaw ? Number(colRaw) : undefined,
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

/** Resolves `path` against `cwd` (POSIX, or Windows drive paths); `~` expands with `home` when known. */
export function resolvePath(path: string, cwd: string, home?: string | null): string {
  let p = path.replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) {
    if (!home) return p;
    p = home.replace(/\\/g, "/") + p.slice(1);
  } else if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) {
    p = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${p}`;
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join("/");
  // A Windows drive prefix is its own root; POSIX results keep the leading slash.
  return /^[A-Za-z]:\//.test(joined) ? joined : `/${joined}`;
}

const LEADING_WRAP = new Set(['"', "'", "`", "(", "[", "{", "<"]);
const TRAILING_PUNCT = new Set(['"', "'", "`", "}", ">", ",", ";", "!", "?"]);

function normalizeCandidatePath(raw: string): string {
  if (raw === "/" || raw === "\\" || /^[A-Za-z]:[\\/]$/.test(raw)) return raw;
  return raw.replace(/[\\/]+$/, "");
}

function isPlausiblePathCandidate(raw: string, quoted = false): boolean {
  if (!raw || raw.length > 512) return false;
  if (raw === "." || raw === "..") return false;
  if (raw.startsWith("-") || raw === "+" || raw === "+++") return false;
  if (quoted && (raw.match(/\s/g)?.length ?? 0) > 6) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^(?:mailto|javascript|data):/i.test(raw)) return false;
  if (/^[\w.-]+@[\w.-]+:/.test(raw)) return false;
  if (!/[\p{L}\p{N}_]/u.test(raw)) return false;
  if (/^\d+$/.test(raw) || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return false;
  return true;
}

function trimTokenBounds(text: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  let end = to;
  // Strip `flag=path` / `KEY=path` prefixes (`--config=src/a.json`, `OUT_DIR=/tmp/out`).
  const eq = /^(--?[\w-]+|[A-Za-z_]\w*)=/.exec(text.slice(start, end));
  if (eq && start + eq[0].length < end) start += eq[0].length;

  while (start < end && LEADING_WRAP.has(text[start]!)) start++;
  for (; end > start;) {
    const ch = text[end - 1]!;
    if (TRAILING_PUNCT.has(ch)) {
      end--;
      continue;
    }
    if (ch === ":" && !(end - start === 2 && /^[A-Za-z]:$/.test(text.slice(start, end)))) {
      end--;
      continue;
    }
    if (ch === "." && text.slice(start, end) !== "." && text.slice(start, end) !== "..") {
      end--;
      continue;
    }
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      const slice = text.slice(start, end);
      const opens = slice.split(open).length - 1;
      const closes = slice.split(ch).length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return { start, end };
}

/**
 * Bare file and folder path candidates on a terminal line (`README.md`, `src/`,
 * `crates/ide-host`, `/tmp/logs`, `"my dir/file.ts"`), excluding spans already
 * claimed by URL or `path:line[:col]` links. Ordered longest-first when nested
 * (e.g. a quoted spaced path ahead of its inner whitespace-split tokens).
 */
export function findPathCandidates(text: string, existing = findTerminalLinks(text)): PathCandidate[] {
  const overlapsLink = (s: number, e: number) => existing.some((l) => s < l.end && e > l.start);
  const seen = new Set<string>();
  const out: PathCandidate[] = [];
  const push = (start: number, end: number, quoted: boolean) => {
    if (end <= start || overlapsLink(start, end)) return;
    const slice = text.slice(start, end);
    if (!isPlausiblePathCandidate(slice, quoted)) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ start, end, text: slice, path: slice });
  };

  for (const m of text.matchAll(/(['"`])([^'"`\r\n]{1,256})\1/g)) {
    const inner = m[2]!;
    const trimmed = inner.trim();
    if (!trimmed) continue;
    const lead = inner.indexOf(trimmed);
    const start = m.index + 1 + lead;
    const end = start + trimmed.length;
    push(start, end, true);
  }

  for (const m of text.matchAll(/\S+/g)) {
    const { start, end } = trimTokenBounds(text, m.index, m.index + m[0].length);
    push(start, end, false);
  }

  return out.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
}

export { normalizeCandidatePath };
