/**
 * Clickable locations in run output: compiler diagnostics and stack traces for
 * common toolchains, plus URLs. Positions are 1-based as printed; consumers
 * convert to the IDE's 0-based lines.
 */

export interface FileTarget {
  /** As printed (relative, absolute or a bare file name). */
  path: string;
  line?: number;
  col?: number;
  /**
   * `path`: resolve against the run directory; `name`: a file name from a JVM
   * stack frame — look it up in the project (`path` then is the file under its
   * package directory, `com/acme/OrderController.kt`, when the frame names the class);
   * `rubyTest`: a Minitest test with no file in its output — `className` is its class, `path` its
   * method name — found by searching the project (`rubyTests.ts`).
   */
  resolve: "path" | "name" | "rubyTest";
  /** JVM frames: the class's binary name (`com.acme.OrderController$Inner`). */
  className?: string;
  /** No line: the describe chain and name of a JS test, found in the file (Cypress prints no line). */
  test?: string[];
}

/**
 * The target of a JVM stack frame `at com.acme.Foo.bar(Foo.kt:22)`: the file
 * under its package directory, so frames resolve by fully qualified class name
 * (as in IDEA), not by a bare file name that several packages may share.
 */
export function jvmFrameTarget(className: string | undefined, file: string, line: number | undefined): FileTarget {
  const pkg = className?.includes(".") ? className.slice(0, className.lastIndexOf(".")).replace(/\./g, "/") : "";
  return {
    path: pkg ? `${pkg}/${file}` : file,
    line,
    resolve: "name",
    ...(className ? { className } : {}),
  };
}

export type OutputLink =
  | { kind: "url"; start: number; end: number; url: string }
  | { kind: "file"; start: number; end: number; target: FileTarget };

const num = (s: string | undefined) => (s ? Number(s) : undefined);

// All link matchers anchor on a fixed delimiter or bounded suffix so scanning
// stays strictly linear even on multi-kilobyte lines with no matches.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
const PYTHON_RE = /File "([^"]+)", line (\d+)/g;
const JVM_FRAME_RE = /\(([\w$.-]+\.(?:java|kt|kts|scala|groovy|clj)):(\d+)\)/g;
const NODE_SUFFIX_RE = /(\.[A-Za-z]\w{0,9}):(\d+):(\d+)/g;
const GENERIC_SUFFIX_RE = /(\.[A-Za-z]\w{0,9})(?::\[?(\d+)(?::(\d+)|,(\d+)\])?|\((\d+)(?:,(\d+))?\))/g;

function isWord(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isSlash(c: number): boolean {
  return c === 47 || c === 92;
}

function isJvmClassChar(c: number): boolean {
  return isWord(c) || c === 36;
}

function isJvmMethodChar(c: number): boolean {
  return isWord(c) || c === 36 || c === 60 || c === 62 || c === 45;
}

function isPathSegChar(c: number): boolean {
  return isWord(c) || c === 46 || c === 64 || c === 43 || c === 45;
}

function isGenericBoundaryBlock(c: number): boolean {
  return isWord(c) || c === 47 || c === 46 || c === 126 || c === 45;
}

/** Extracts `com.acme.Foo` from `…com.acme.Foo.bar(` immediately before `parenIdx`. */
function jvmClassBefore(text: string, parenIdx: number): string | undefined {
  let methodStart = parenIdx;
  while (methodStart > 0 && isJvmMethodChar(text.charCodeAt(methodStart - 1))) methodStart--;
  if (methodStart === parenIdx || methodStart === 0 || text.charCodeAt(methodStart - 1) !== 46) return undefined;
  const dotIdx = methodStart - 1;
  let pos = dotIdx;
  let classStart = dotIdx;
  for (;;) {
    let i = pos;
    while (i > 0 && isJvmClassChar(text.charCodeAt(i - 1))) i--;
    if (i === pos) break;
    classStart = i;
    if (i > 0 && text.charCodeAt(i - 1) === 46) pos = i - 1;
    else break;
  }
  return classStart < dotIdx ? text.slice(classStart, dotIdx) : undefined;
}

/**
 * Finds the leftmost start index (>= `minStart`) of a valid path ending at `dotIdx`,
 * matching `(?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?(?:[\w.@+\-]+[\\/])*[\w@+\-][\w.@+\-]*`,
 * or -1 if no valid stem precedes `dotIdx`.
 */
function findPathStart(text: string, dotIdx: number, minStart: number): number {
  let segStart = dotIdx;
  while (segStart > minStart && isPathSegChar(text.charCodeAt(segStart - 1))) segStart--;
  if (segStart === dotIdx) return -1;
  if (text.charCodeAt(segStart) === 46) {
    let stemStart = segStart + 1;
    while (stemStart < dotIdx && text.charCodeAt(stemStart) === 46) stemStart++;
    return stemStart < dotIdx ? stemStart : -1;
  }
  let pos = segStart;
  while (pos > minStart && isSlash(text.charCodeAt(pos - 1))) {
    const slashIdx = pos - 1;
    let seg = slashIdx;
    while (seg > minStart && isPathSegChar(text.charCodeAt(seg - 1))) seg--;
    if (seg < slashIdx) {
      pos = seg;
      continue;
    }
    if (
      slashIdx - 2 >= minStart &&
      text.charCodeAt(slashIdx - 1) === 58 &&
      isAsciiLetter(text.charCodeAt(slashIdx - 2))
    ) {
      pos = slashIdx - 2;
    } else if (text.charCodeAt(slashIdx) === 47) {
      pos = slashIdx - 1 >= minStart && text.charCodeAt(slashIdx - 1) === 126 ? slashIdx - 1 : slashIdx;
    }
    break;
  }
  return pos;
}

function trimUrl(url: string): string {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) {
    const c = url.charCodeAt(i);
    if (c === 40) open++;
    else if (c === 41) close++;
  }
  while (end > 0) {
    const last = url[end - 1]!;
    if (".,;:!?'\"".includes(last)) {
      end--;
      continue;
    }
    if (last === ")" && open < close) {
      close--;
      end--;
      continue;
    }
    break;
  }
  return end === url.length ? url : url.slice(0, end);
}

/** Merges sorted non-overlapping `added` links into sorted non-overlapping `existing` links. */
function mergeLinks(existing: OutputLink[], added: OutputLink[]): OutputLink[] {
  if (added.length === 0) return existing;
  if (existing.length === 0) return added;
  const out: OutputLink[] = [];
  let i = 0;
  let j = 0;
  while (i < existing.length && j < added.length) {
    if (existing[i]!.start <= added[j]!.start) out.push(existing[i++]!);
    else out.push(added[j++]!);
  }
  while (i < existing.length) out.push(existing[i++]!);
  while (j < added.length) out.push(added[j++]!);
  return out;
}

/** Linear overlap filter for sorted candidate links against sorted `existing` links. */
function makeOverlapFilter(existing: readonly OutputLink[]): (s: number, e: number) => boolean {
  if (existing.length === 0) return () => true;
  let cursor = 0;
  return (s: number, e: number) => {
    while (cursor < existing.length && existing[cursor]!.end <= s) cursor++;
    return cursor >= existing.length || existing[cursor]!.start >= e;
  };
}

/** Finds non-overlapping links in `text`; earlier (more specific) patterns win. */
export function findOutputLinks(text: string): OutputLink[] {
  // Lifting this limit made streaming wide rows full of links drop frames in WebKit.
  if (text.length > 4000) return [];
  const hasColon = text.includes(":");
  const hasParen = text.includes("(");
  const hasDot = text.includes(".");
  const hasPython = text.includes('File "');
  if (!hasColon && !hasParen && !hasPython) return [];

  let links: OutputLink[] = [];

  if (hasColon && text.includes("://")) {
    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
      const url = trimUrl(m[0]);
      links.push({ kind: "url", start: m.index, end: m.index + url.length, url });
    }
  }

  if (hasPython) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    PYTHON_RE.lastIndex = 0;
    for (let m = PYTHON_RE.exec(text); m; m = PYTHON_RE.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (free(start, end)) {
        added.push({ kind: "file", start, end, target: { path: m[1]!, line: num(m[2]), resolve: "path" } });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasParen && hasColon && hasDot) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    JVM_FRAME_RE.lastIndex = 0;
    for (let m = JVM_FRAME_RE.exec(text); m; m = JVM_FRAME_RE.exec(text)) {
      const parenIdx = m.index;
      const file = m[1]!;
      const lineStr = m[2]!;
      const start = parenIdx + 1;
      const end = start + file.length + 1 + lineStr.length;
      if (free(start, end)) {
        added.push({
          kind: "file",
          start,
          end,
          target: jvmFrameTarget(jvmClassBefore(text, parenIdx), file, num(lineStr)),
        });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasColon && hasDot) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    NODE_SUFFIX_RE.lastIndex = 0;
    let minStart = 0;
    for (let m = NODE_SUFFIX_RE.exec(text); m; m = NODE_SUFFIX_RE.exec(text)) {
      const dotIdx = m.index;
      const extEnd = dotIdx + m[1]!.length;
      const end = dotIdx + m[0].length;
      const pathStart = findPathStart(text, dotIdx, minStart);
      if (pathStart < 0) continue;
      let start = pathStart;
      let filePathStart = pathStart;
      if (pathStart >= minStart + 7 && text.startsWith("file://", pathStart - 7)) {
        start = pathStart - 7;
      } else if (
        text.charCodeAt(pathStart) === 47 &&
        pathStart + 1 < dotIdx &&
        pathStart >= minStart + 6 &&
        text.startsWith("file://", pathStart - 6)
      ) {
        start = pathStart - 6;
        filePathStart = pathStart + 1;
      }
      minStart = end;
      if (free(start, end)) {
        added.push({
          kind: "file",
          start,
          end,
          target: { path: text.slice(filePathStart, extEnd), line: num(m[2]), col: num(m[3]), resolve: "path" },
        });
      }
    }
    links = mergeLinks(links, added);
  }

  if (hasDot && (hasColon || hasParen)) {
    const free = makeOverlapFilter(links);
    const added: OutputLink[] = [];
    GENERIC_SUFFIX_RE.lastIndex = 0;
    let minStart = 0;
    for (let m = GENERIC_SUFFIX_RE.exec(text); m; m = GENERIC_SUFFIX_RE.exec(text)) {
      const dotIdx = m.index;
      const extEnd = dotIdx + m[1]!.length;
      const end = dotIdx + m[0].length;
      const pathStart = findPathStart(text, dotIdx, minStart);
      if (pathStart < 0) continue;
      minStart = end;
      if (pathStart > 0 && isGenericBoundaryBlock(text.charCodeAt(pathStart - 1))) continue;
      if (free(pathStart, end)) {
        added.push({
          kind: "file",
          start: pathStart,
          end,
          target: {
            path: text.slice(pathStart, extEnd),
            line: num(m[2] ?? m[5]),
            col: num(m[3] ?? m[4] ?? m[6]),
            resolve: "path",
          },
        });
      }
    }
    links = mergeLinks(links, added);
  }

  return links;
}

/** Joins `path` onto `base` (POSIX), normalising `.`/`..`. Absolute paths are kept. */
export function joinPath(base: string, path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const full = p.startsWith("/") || /^[A-Za-z]:\//.test(p) ? p : `${base.replace(/\/+$/, "")}/${p}`;
  const out: string[] = [];
  for (const seg of full.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return (/^[A-Za-z]:$/.test(out[0] ?? "") ? "" : "/") + out.join("/");
}
