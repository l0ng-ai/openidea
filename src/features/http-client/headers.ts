/** Header name and value completion in `.http` request blocks (the lines after the request line). */
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { METHODS } from "./language";

const REQUEST_LINE = new RegExp(`^\\s*(?:(?:${METHODS.join("|")})\\s+\\S|https?://|\\{\\{)`);
const COMMENT = /^\s*(?:#|\/\/)/;

const HEADERS = [
  "Accept",
  "Accept-Charset",
  "Accept-Encoding",
  "Accept-Language",
  "Access-Control-Request-Headers",
  "Access-Control-Request-Method",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Disposition",
  "Content-Encoding",
  "Content-Language",
  "Content-Length",
  "Content-Type",
  "Cookie",
  "Date",
  "Expect",
  "Forwarded",
  "From",
  "Host",
  "If-Match",
  "If-Modified-Since",
  "If-None-Match",
  "If-Range",
  "If-Unmodified-Since",
  "Max-Forwards",
  "Origin",
  "Pragma",
  "Proxy-Authorization",
  "Range",
  "Referer",
  "TE",
  "Upgrade",
  "User-Agent",
  "Via",
  "X-Correlation-ID",
  "X-CSRF-Token",
  "X-Forwarded-For",
  "X-Forwarded-Host",
  "X-Forwarded-Proto",
  "X-Request-ID",
  "X-Requested-With",
];

const MEDIA_TYPES = [
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "text/html",
  "text/xml",
  "text/csv",
  "application/octet-stream",
  "application/graphql",
  "application/x-ndjson",
  "application/problem+json",
  "*/*",
];

const VALUES: Record<string, string[]> = {
  accept: MEDIA_TYPES,
  "content-type": MEDIA_TYPES,
  "accept-encoding": ["gzip, deflate, br", "gzip", "deflate", "br", "identity"],
  "content-encoding": ["gzip", "deflate", "br"],
  "accept-charset": ["utf-8", "iso-8859-1"],
  "accept-language": ["en-US", "en", "zh-CN", "zh"],
  authorization: ["Bearer ", "Basic "],
  "proxy-authorization": ["Bearer ", "Basic "],
  "cache-control": ["no-cache", "no-store", "max-age=0", "must-revalidate"],
  pragma: ["no-cache"],
  connection: ["keep-alive", "close", "Upgrade"],
  upgrade: ["websocket", "h2c"],
  expect: ["100-continue"],
  "x-requested-with": ["XMLHttpRequest"],
  "content-disposition": ["attachment", "inline", 'form-data; name=""'],
  "access-control-request-method": METHODS,
};

export type HeaderTarget =
  | { kind: "name"; from: number; prefix: string }
  | { kind: "value"; name: string; from: number; prefix: string };

/** What is being typed at `pos`: a header name or a header's value, or null outside a request's headers. */
export function headerTarget(text: string, pos: number): HeaderTarget | null {
  const before = text.slice(0, pos);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  if (COMMENT.test(line)) return null;
  const lines = (
    before
      .slice(0, lineStart)
      .split(/^\s*###.*$/m)
      .at(-1) ?? ""
  )
    .split("\n")
    .slice(0, -1);
  let request = false;
  for (const l of lines) {
    if (COMMENT.test(l)) continue;
    if (!request) request = REQUEST_LINE.test(l);
    // A blank line ends the headers; the body follows.
    else if (!l.trim()) return null;
  }
  if (!request) return null;
  const colon = line.indexOf(":");
  if (colon < 0) return /^[\w-]*$/.test(line) ? { kind: "name", from: lineStart, prefix: line } : null;
  const prefix = line.slice(colon + 1).replace(/^\s+/, "");
  return { kind: "value", name: line.slice(0, colon).trim(), from: pos - prefix.length, prefix };
}

export function headerCompletion(context: CompletionContext): CompletionResult | null {
  const target = headerTarget(context.state.doc.toString(), context.pos);
  if (!target) return null;
  if (target.kind === "name") {
    if (!target.prefix && !context.explicit) return null;
    const options: Completion[] = HEADERS.map((name) => ({ label: name, type: "property", apply: `${name}: ` }));
    return { from: target.from, options, validFor: /^[\w-]*$/ };
  }
  const values = VALUES[target.name.toLowerCase()];
  if (!values) return null;
  return { from: target.from, options: values.map((v) => ({ label: v, type: "constant" })) };
}
