/**
 * Navigate › Declaration (⌘-click, ⌘B) on a request URL in a `.http` file: the
 * handler of the endpoint the request reaches (a Spring mapping, a plugin's
 * endpoint), matched by method and path.
 */
import type { Text } from "@codemirror/state";
import { registerNavigationProvider, type NavigationMatch } from "@/editor/api";
import { docOf } from "@/editor/lsp/lsp";
import { useProject } from "@/platform/project";
import { searchEndpoints, type EndpointEntry } from "@/workbench/contributions";
import { HTTP_LANGUAGE } from "./editor";
import { METHODS } from "./language";

/** The request line holding `offset`: its method and the path part of the URL, as document offsets. */
export function requestPathAt(
  doc: Text,
  offset: number,
): { method: string; path: string; from: number; to: number } | null {
  const line = doc.lineAt(offset);
  const m = new RegExp(`^(\\s*(?:(${METHODS.join("|")})\\s+)?)(\\S+)`).exec(line.text);
  if (!m) return null;
  const url = m[3]!;
  // The scheme and host, or a `{{host}}` variable standing for them.
  const origin = /^(?:https?:\/\/[^/\s?#]+|\{\{[^}]+\}\}(?=\/))/.exec(url)?.[0];
  if (origin === undefined && !(m[2] && url.startsWith("/"))) return null;
  const start = line.from + m[1]!.length;
  if (offset < start || offset > start + url.length) return null;
  const path = url.slice(origin?.length ?? 0).replace(/[?#].*$/, "");
  // No path (`http://host`): the whole URL is the link.
  const from = path ? start + (origin?.length ?? 0) : start;
  return { method: m[2] ?? "GET", path: path || "/", from, to: path ? from + path.length : start + url.length };
}

const segments = (p: string) => p.split("/").filter(Boolean);

/** How `request` segments match mapping `pattern` segments: `{var}`, `*` and `**` in the mapping, `{{var}}` in the request. */
function matches(request: string[], pattern: string[]): boolean {
  if (!pattern.length) return !request.length;
  const [p, ...rest] = pattern;
  if (p === "**") return request.some((_, i) => matches(request.slice(i), rest)) || matches([], rest);
  if (!request.length) return false;
  const [r, ...more] = request;
  const variable = /^\{[^}]*\}$/.test(p!) || p === "*" || /^\{\{[^}]+\}\}$/.test(r!);
  return (variable || decodeURIComponent(r!) === p) && matches(more, rest);
}

/** Endpoints `method` `path` reaches: the exact path, else after a context path (`/app` + mapping). */
export function endpointsFor(endpoints: readonly EndpointEntry[], method: string, path: string): EndpointEntry[] {
  const request = segments(path);
  const sameMethod = endpoints.filter((e) => e.method === method || e.method === "*");
  const exact = sameMethod.filter((e) => matches(request, segments(e.url)));
  if (exact.length) return exact;
  for (let skip = 1; skip < request.length; skip++) {
    const found = sameMethod.filter((e) => matches(request.slice(skip), segments(e.url)));
    if (found.length) return found;
  }
  return [];
}

export async function urlTargets(doc: Text, offset: number): Promise<NavigationMatch | null> {
  const at = requestPathAt(doc, offset);
  if (!at) return null;
  const endpoints = await searchEndpoints(useProject.getState().project?.root ?? null);
  const found = endpointsFor(endpoints, at.method, at.path);
  if (!found.length) return null;
  return {
    from: at.from,
    to: at.to,
    targets: found.map((e) => ({
      path: e.path,
      range: { start: { line: e.line, col: e.col }, end: { line: e.line, col: e.col + e.methodName.length } },
      name: e.handler ?? `${e.controller}.${e.methodName}`,
    })),
  };
}

export function registerUrlNavigation(): () => void {
  return registerNavigationProvider(async (view, offset) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || doc.language !== HTTP_LANGUAGE) return null;
    return urlTargets(view.state.doc, offset);
  });
}
