/** `workspace/symbol` lookups shared by the per-language documentation link rules. */
import { call, commands, nextRequestId, type Location, type WorkspaceSymbol } from "@/platform/ipc";

export interface DocTarget {
  path: string;
  line: number;
  col: number;
}

export async function symbols(query: string): Promise<WorkspaceSymbol[]> {
  return call(commands.lspWorkspaceSymbols(nextRequestId(), query)).catch(() => []);
}

/** The one place `hits` name (the same place listed twice counts once); null when none or several. */
export function unique(hits: { location: Location }[]): DocTarget | null {
  const places = new Map(
    hits.map((s) => {
      const { path, range } = s.location;
      return [`${path}:${range.start.line}:${range.start.col}`, { path, ...range.start }] as const;
    }),
  );
  return places.size === 1 ? [...places.values()][0]! : null;
}
