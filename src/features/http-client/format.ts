/** Response body presentation: content kind detection and pretty-printing. */
import { formatJsonText } from "@/platform/losslessJson";

export type BodyKind = "json" | "xml" | "html" | "text";

export function bodyKind(contentType: string | null | undefined, body: string): BodyKind {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  const t = body.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(body);
      return "json";
    } catch {
      return "text";
    }
  }
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return "html";
  if (t.startsWith("<?xml") || /^<[A-Za-z][\w:.-]*[\s>/]/.test(t)) return "xml";
  return "text";
}

/** Pretty-printed JSON with numeric values kept exact (BIGINT ids, high-precision decimals); other bodies as received. */
export function prettyJson(body: string): string {
  try {
    return formatJsonText(body) ?? body;
  } catch {
    return body;
  }
}

const VOID_HTML = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Re-indents XML / HTML by tag nesting. Text-only elements stay on one line;
 * `<script>` / `<style>` / `<pre>` contents and comments are kept as written.
 */
export function prettyMarkup(body: string, html = false, indent = "  "): string {
  // Split into tags / comments / text; raw elements (script, style, pre) stay one token.
  const tokens: string[] = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+|</g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const tok = m[0];
    const name = /^<\s*([\w:.-]+)/.exec(tok)?.[1]?.toLowerCase();
    if (html && name && (name === "script" || name === "style" || name === "pre") && !tok.endsWith("/>")) {
      const close = body.toLowerCase().indexOf(`</${name}`, re.lastIndex);
      const end = close < 0 ? body.length : body.indexOf(">", close) + 1 || body.length;
      tokens.push(body.slice(m.index, end));
      re.lastIndex = end;
      continue;
    }
    tokens.push(tok);
  }
  if (!tokens.length) return body;
  const out: string[] = [];
  let depth = 0;
  const pad = () => indent.repeat(Math.max(0, depth));
  const isTag = (t: string | undefined) => !!t && /^<[!?/\w]/.test(t);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!isTag(tok)) {
      const text = tok.trim();
      if (text) out.push(pad() + text);
      continue;
    }
    if (tok.startsWith("<!") || tok.startsWith("<?")) {
      out.push(pad() + tok);
      continue;
    }
    if (tok.startsWith("</")) {
      depth--;
      out.push(pad() + tok);
      continue;
    }
    const name = /^<\s*([\w:.-]+)/.exec(tok)?.[1]?.toLowerCase() ?? "";
    const raw = html && (name === "script" || name === "style" || name === "pre");
    if (raw || tok.endsWith("/>") || (html && VOID_HTML.has(name))) {
      out.push(pad() + tok);
      continue;
    }
    // `<a>text</a>` and `<a></a>` on one line.
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (next !== undefined && !isTag(next) && after?.startsWith("</")) {
      out.push(pad() + tok + next.trim() + after);
      i += 2;
      continue;
    }
    if (next?.startsWith("</")) {
      out.push(pad() + tok + next);
      i += 1;
      continue;
    }
    out.push(pad() + tok);
    depth++;
  }
  return out.join("\n");
}

export function prettyBody(kind: BodyKind, body: string): string {
  switch (kind) {
    case "json":
      return prettyJson(body);
    case "xml":
      return prettyMarkup(body, false);
    case "html":
      return prettyMarkup(body, true);
    default:
      return body;
  }
}

export function formatSize(value: number | null): string {
  const bytes = value ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatMs(value: number | null): string {
  const ms = value ?? 0;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
