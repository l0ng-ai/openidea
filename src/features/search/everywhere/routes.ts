/**
 * Request-path index for Search Everywhere: every Spring `@…Mapping` method of the
 * project, matched by the URL it answers — `/tg-tenant/deeplink/menu/search` finds
 * `DeepLinkController.searchMenus`, the way IDEA finds a controller by its endpoint.
 * The annotations are read by the HTTP client's parser; this module caches the
 * result per project and ranks the matches.
 */
import { call, commands } from "@/platform/ipc";
import { springControllers } from "@/features/http-client/spring/endpoints";
import { matchText } from "../common/rank";
import type { SymbolItem } from "./model";

export interface Route {
  /** `GET`, `POST`, … */
  method: string;
  /** Class-level and method-level mapping joined; `{var}` kept. */
  url: string;
  controller: string;
  methodName: string;
  path: string;
  rel: string;
  line: number;
  col: number;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);

let cached: { root: string; promise: Promise<Route[]> } | null = null;

/** The project's routes, scanned once per project and kept in memory. */
export function routeIndex(root: string | null): Promise<Route[]> {
  if (!root) return Promise.resolve([]);
  if (cached?.root === root) return cached.promise;
  const promise = scan(root);
  cached = { root, promise };
  return promise;
}

async function scan(root: string): Promise<Route[]> {
  const sources = await call(commands.springRouteSources());
  const routes: Route[] = [];
  for (const source of sources) {
    if (!source.path.startsWith(root)) continue;
    for (const controller of springControllers(source.text)) {
      for (const endpoint of controller.endpoints) {
        const at = lineCol(source.text, endpoint.offset);
        // A mapping without a path answers nothing to look up by URL; the method
        // itself is still reachable through the symbol index.
        for (const url of endpoint.paths) {
          routes.push({
            method: endpoint.httpMethod,
            url,
            controller: controller.name,
            methodName: endpoint.methodName,
            path: source.path,
            rel: source.path.slice(root.length + 1),
            line: at.line,
            col: at.col,
          });
        }
      }
    }
  }
  return routes;
}

function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

const strip = (s: string) => s.replace(/^\/+|\/+$/g, "");

function item(r: Route, indices: number[], score: number): SymbolItem {
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
  routes: readonly Route[],
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
