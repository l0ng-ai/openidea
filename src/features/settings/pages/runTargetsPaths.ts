/** Parent of a remote path (`~/a` → `~`, `/a` → `/`); null at the top. */
export function parentPath(path: string): string | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (p === "/" || p === "~" || p === "") return null;
  const i = p.lastIndexOf("/");
  if (i < 0) return null;
  return i === 0 ? "/" : p.slice(0, i);
}

/** Settings typed as lists of words (`8000:8000 5678:5678`, `a.yaml; b.yaml`). */
export const splitList = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
