/** Link detection in terminal lines: URLs and `path:line[:col]` file locations. */

export type TerminalLink =
  | { kind: "url"; start: number; end: number; text: string; url: string }
  | { kind: "file"; start: number; end: number; text: string; path: string; line?: number; col?: number };

const URL_RE = /\b(?:https?|file):\/\/[^\s<>"'`]+/g;

// `src/main.rs:10:5`, `./a/b.ts:3`, `/abs/x.py:12`, `foo.go(12,3)`, `Foo.kt:22`.
const FILE_RE =
  /((?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:[,:](\d+))?\))/g;

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

export function findTerminalLinks(text: string): TerminalLink[] {
  const links: TerminalLink[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    links.push({ kind: "url", start: m.index, end: m.index + url.length, text: url, url });
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

/** Resolves `path` against `cwd` (POSIX); `~` expands with `home` when known. */
export function resolvePath(path: string, cwd: string, home?: string | null): string {
  let p = path;
  if (p === "~" || p.startsWith("~/")) {
    if (!home) return p;
    p = home + p.slice(1);
  } else if (!p.startsWith("/")) {
    p = `${cwd.replace(/\/+$/, "")}/${p}`;
  }
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
