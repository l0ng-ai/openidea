/**
 * Languages & Frameworks › SQL Resolution Scopes: the data source (and schema) SQL in a
 * file or folder resolves against. The most specific path wins; an empty path is the
 * whole project.
 */
export interface SqlResolutionScope {
  /** Project-relative file or folder, `/`-separated; empty for the whole project. */
  path: string;
  dataSource: string;
  schema: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Normalises a project-relative path: `/`-separated, without `./` or surrounding slashes. */
export function scopePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

export function validateResolutionScopes(raw: unknown): SqlResolutionScope[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const o = r as Record<string, unknown>;
    return [{ path: scopePath(str(o.path)), dataSource: str(o.dataSource), schema: str(o.schema).trim() }];
  });
}

/** The scopes in raw settings (`database.resolutionScopes`). */
export function resolutionScopesOf(settings: unknown): SqlResolutionScope[] {
  const database = (settings as { database?: { resolutionScopes?: unknown } } | null)?.database;
  return validateResolutionScopes(database?.resolutionScopes);
}

/**
 * The scope of `file` (absolute, under project `root`) among `scopes` whose data source
 * `known` accepts: the deepest folder or the file itself, else the project's row.
 */
export function resolutionScopeOf(
  file: string,
  root: string,
  scopes: readonly SqlResolutionScope[],
  known: (dataSource: string) => boolean = () => true,
): SqlResolutionScope | null {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = file.replace(/\\/g, "/");
  if (!base || !normalized.startsWith(`${base}/`)) return null;
  const rel = normalized.slice(base.length + 1);
  let best: SqlResolutionScope | null = null;
  for (const scope of scopes) {
    if (!scope.dataSource || !known(scope.dataSource)) continue;
    const p = scope.path;
    const covers = !p || rel === p || rel.startsWith(`${p}/`);
    if (covers && (!best || p.length > best.path.length)) best = scope;
  }
  return best;
}
