/** File Colors for the views that show them (project view, editor tabs). */
import { useMemo } from "react";
import { fileColorOf, fileColorSettings, type FileColorPlace } from "@/platform/fileColors";
import { useProject } from "@/platform/project";
import { useScopeContext } from "@/platform/scopes";
import { useProjectViewRoots } from "./contributions";

const rawFileColors = (s: { settings: unknown }) => (s.settings as { fileColors?: unknown } | null)?.fileColors;

/**
 * The colour lookup of `place`, or null while file colours are off there. It changes
 * with the settings and the project's roots; lookups are memoised per path.
 */
export function useFileColors(place: FileColorPlace): ((path: string, dir?: boolean) => string | undefined) | null {
  const raw = useProject(rawFileColors);
  const ctx = useScopeContext();
  const extra = useProjectViewRoots((s) => s.roots);
  return useMemo(() => {
    const s = fileColorSettings(raw);
    if (!s.enabled || !s[place] || !s.colors.length) return null;
    // Scratches are neither project nor non-project files.
    const ownFolders = [...extra.values()].flatMap((r) => (r.scope === "scratches" && r.path ? [r.path] : []));
    const scope = { ...ctx, ownFolders };
    const memo = new Map<string, string | undefined>();
    return (path, dir = false) => {
      const key = dir ? `${path}/` : path;
      if (!memo.has(key)) memo.set(key, fileColorOf(path, s, scope, dir));
      return memo.get(key);
    };
  }, [raw, ctx, extra, place]);
}
