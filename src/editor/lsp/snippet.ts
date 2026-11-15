/**
 * LSP snippet syntax → `@codemirror/autocomplete` snippet templates.
 *
 * LSP: `$1`, `${1}`, `${1:default}` (nestable), `${1|a,b|}`, `$0`, `$VAR`,
 * `${VAR:default}`, transforms `${1/re/fmt/}`, backslash escapes for `$ } \`.
 * CodeMirror: `${1}`, `${1:name}`, `${name}`, `${0}` (final caret); literal
 * braces must be escaped as `\{` / `\}`; field names cannot contain braces or
 * span lines and nested fields are not supported, so nested placeholders are
 * flattened into their parent's text.
 */

type Node =
  | { t: "text"; v: string }
  | { t: "tab"; n: number; children: Node[] | null }
  | { t: "choice"; n: number; options: string[] }
  | { t: "var"; name: string; children: Node[] | null };

function parse(src: string): Node[] {
  let i = 0;

  const parseSeq = (inside: boolean): Node[] => {
    const out: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ t: "text", v: text });
      text = "";
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\" && i + 1 < src.length && "$}\\".includes(src[i + 1]!)) {
        text += src[i + 1];
        i += 2;
        continue;
      }
      if (inside && c === "}") break;
      if (c === "$") {
        const node = parseDollar();
        if (node) {
          flush();
          out.push(node);
          continue;
        }
      }
      text += c;
      i++;
    }
    flush();
    return out;
  };

  const readInt = (): number | null => {
    const m = /^\d+/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const readName = (): string | null => {
    const m = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  /** Skips a `/regex/format/options}` transform, leaving `i` after the closing brace. */
  const skipTransform = (): boolean => {
    i++; // leading slash
    let segment = 0; // 0 regex, 1 format, 2 options
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (segment < 2 && c === "/" && depth === 0) segment++;
      else if (segment === 1 && c === "{") depth++;
      else if (segment === 1 && c === "}" && depth > 0) depth--;
      else if (segment === 2 && c === "}") {
        i++;
        return true;
      }
      i++;
    }
    return false;
  };

  const parseDollar = (): Node | null => {
    const start = i;
    i++; // $
    if (src[i] !== "{") {
      const n = readInt();
      if (n !== null) return { t: "tab", n, children: null };
      const name = readName();
      if (name !== null) return { t: "var", name, children: null };
      i = start;
      return null;
    }
    i++; // {
    const fail = () => {
      i = start;
      return null;
    };
    const n = readInt();
    if (n !== null) {
      const c = src[i];
      if (c === "}") {
        i++;
        return { t: "tab", n, children: null };
      }
      if (c === ":") {
        i++;
        const children = parseSeq(true);
        if (src[i] !== "}") return fail();
        i++;
        return { t: "tab", n, children };
      }
      if (c === "|") {
        i++;
        const options: string[] = [];
        let cur = "";
        while (i < src.length) {
          const ch = src[i]!;
          if (ch === "\\" && i + 1 < src.length && "$}\\,|".includes(src[i + 1]!)) {
            cur += src[i + 1];
            i += 2;
          } else if (ch === ",") {
            options.push(cur);
            cur = "";
            i++;
          } else if (ch === "|" && src[i + 1] === "}") {
            options.push(cur);
            i += 2;
            return { t: "choice", n, options };
          } else {
            cur += ch;
            i++;
          }
        }
        return fail();
      }
      if (c === "/") return skipTransform() ? { t: "tab", n, children: null } : fail();
      return fail();
    }
    const name = readName();
    if (name === null) return fail();
    const c = src[i];
    if (c === "}") {
      i++;
      return { t: "var", name, children: null };
    }
    if (c === ":") {
      i++;
      const children = parseSeq(true);
      if (src[i] !== "}") return fail();
      i++;
      return { t: "var", name, children };
    }
    if (c === "/") return skipTransform() ? { t: "var", name, children: null } : fail();
    return fail();
  };

  return parseSeq(false);
}

export type SnippetVariables = Record<string, string | undefined>;

const escapeText = (s: string) => s.replace(/[{}]/g, "\\$&");

/** Plain text of nodes (nested fields contribute their default text). */
function flatten(nodes: Node[], vars: SnippetVariables): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "tab") out += n.children ? flatten(n.children, vars) : "";
    else if (n.t === "choice") out += n.options[0] ?? "";
    else {
      const v = vars[n.name];
      out += v !== undefined ? v : n.children ? flatten(n.children, vars) : n.name;
    }
  }
  return out;
}

function field(n: number | string, text: string): string {
  if (!text) return `\${${n}}`;
  // CodeMirror field names cannot contain braces or newlines: keep the text, lose the selection.
  if (/[{}\n\r]/.test(text)) return `\${${n}}${escapeText(text)}`;
  return `\${${n}:${text}}`;
}

/** Converts an LSP snippet into a CodeMirror snippet template. */
export function lspSnippetToCm(snippet: string, vars: SnippetVariables = {}): string {
  const nodes = parse(snippet);
  const hasField = nodes.some(
    (n) => n.t === "tab" || n.t === "choice" || (n.t === "var" && vars[n.name] === undefined && !n.children),
  );
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += escapeText(n.v);
    else if (n.t === "tab") out += field(n.n, n.children ? flatten(n.children, vars) : "");
    else if (n.t === "choice") out += field(n.n, n.options[0] ?? "");
    else {
      const v = vars[n.name];
      if (v !== undefined) out += escapeText(v);
      else if (n.children) out += escapeText(flatten(n.children, vars));
      // Unknown variable: LSP inserts its name as a placeholder.
      else out += field(n.name, "");
    }
  }
  // CodeMirror leaves the caret before an insertion without fields.
  return hasField ? out : out + "${0}";
}

/** The snippet's text with every field replaced by its default (for previews / plain insertion). */
export function lspSnippetToPlain(snippet: string, vars: SnippetVariables = {}): string {
  return flatten(parse(snippet), vars);
}

/** Standard LSP snippet variables for a file. */
export function snippetVariables(path: string, extra: SnippetVariables = {}): SnippetVariables {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const now = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return {
    TM_FILENAME: name,
    TM_FILENAME_BASE: dot > 0 ? name.slice(0, dot) : name,
    TM_DIRECTORY: slash > 0 ? path.slice(0, slash) : "",
    TM_FILEPATH: path,
    TM_SELECTED_TEXT: "",
    CLIPBOARD: "",
    CURRENT_YEAR: String(now.getFullYear()),
    CURRENT_YEAR_SHORT: String(now.getFullYear()).slice(-2),
    CURRENT_MONTH: pad(now.getMonth() + 1),
    CURRENT_DATE: pad(now.getDate()),
    CURRENT_HOUR: pad(now.getHours()),
    CURRENT_MINUTE: pad(now.getMinutes()),
    CURRENT_SECOND: pad(now.getSeconds()),
    ...extra,
  };
}
