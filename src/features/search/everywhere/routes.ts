/** Request-path and controller-method ranking for Search Everywhere. */
import type { EndpointEntry } from "@/workbench/contributions";
import { matchText } from "../common/rank";
import type { SymbolItem } from "./model";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);

const strip = (s: string) => s.replace(/^\/+|\/+$/g, "");

function item(r: EndpointEntry, indices: number[], score: number): SymbolItem {
  const display = `${r.method} ${r.url}`;
  return {
    kind: "symbol",
    key: `r:${r.path}:${r.line}:${r.method}:${r.url}`,
    name: display,
    display,
    symbolKind: "method",
    container: `${r.controller}.${r.methodName}`,
    path: r.path,
    rel: r.rel,
    line: r.line,
    col: r.col,
    indices,
    score,
  };
}

/**
 * Routes matching `query`: a request path (`/deeplink/menu/search`, with or without
 * the servlet context path), an optional `POST ` prefix, or the controller / method
 * name. Scores: exact path, then a path suffix (a context path in front of it), then
 * a substring, then the symbol names, then a fuzzy path hit.
 */
export function matchRoutes(
  routes: readonly EndpointEntry[],
  query: string,
  limit: number,
): { items: SymbolItem[]; hasMore: boolean } {
  const text = query.trim();
  if (!text || !routes.length) return { items: [], hasMore: false };
  const words = text.split(/\s+/);
  const head = (words[0] ?? "").toUpperCase();
  const method = HTTP_METHODS.has(head) ? head : null;
  const rest = (method ? words.slice(1).join(" ") : text).trim();
  const wantPath = strip(rest).toLowerCase();
  const wantName = rest.toLowerCase();

  const hits: { item: SymbolItem; score: number }[] = [];
  for (const r of routes) {
    if (method && r.method !== method) continue;
    const target = strip(r.url).toLowerCase();
    const qualified = `${r.controller}.${r.methodName}`.toLowerCase();
    let score = 0;
    let indices: number[] = [];
    if (wantPath) {
      if (target === wantPath) score = 1000;
      else if (wantPath.includes("/") && (target.endsWith(`/${wantPath}`) || wantPath.endsWith(`/${target}`)))
        score = 900;
      else if (wantPath.length >= 3 && target.length >= 3 && (target.includes(wantPath) || wantPath.includes(target)))
        score = 700;
      if (score) {
        const at = `${r.method} ${r.url}`.toLowerCase().lastIndexOf(wantPath);
        if (at >= 0) indices = Array.from({ length: wantPath.length }, (_, i) => at + i);
      }
    }
    if (!score && wantName) {
      if (r.methodName.toLowerCase() === wantName) score = 800;
      else if (qualified === wantName || qualified.includes(wantName)) score = 600;
      else if (wantName.length >= 3 && target.includes(wantName)) score = 500;
      else {
        const fuzzy = matchText(target, wantName);
        if (fuzzy) score = 300 + fuzzy.score;
      }
    }
    if (score) hits.push({ item: item(r, indices, score), score });
  }
  hits.sort((a, b) => b.score - a.score || a.item.rel.localeCompare(b.item.rel) || a.item.line - b.item.line);
  return { items: hits.slice(0, limit).map((h) => h.item), hasMore: hits.length > limit };
}
