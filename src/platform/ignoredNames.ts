/** "Ignored Files and Folders" (`files.ignoredNames`): names hidden everywhere; mirrors `ide_core::ignored`. */
import { useProject } from "./project";

/** Defaults of `ide_core::ignored::DEFAULT_IGNORED_NAMES`; used until settings load. */
export const DEFAULT_IGNORED_NAMES: readonly string[] = [
  "*.pyc",
  "*.pyo",
  "*.rbc",
  "*.yarb",
  "*~",
  ".DS_Store",
  ".git",
  ".hg",
  ".jj",
  ".ropeproject",
  ".svn",
  "CVS",
  "__pycache__",
  "_svn",
  "vssver.scc",
  "vssver2.scc",
  "Thumbs.db",
  "desktop.ini",
];

let cached: { names: readonly string[]; exact: Set<string>; wildcards: RegExp[] } | null = null;

function compile(names: readonly string[]) {
  const exact = new Set<string>();
  const wildcards: RegExp[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n || n.includes("/")) continue;
    if (!/[*?]/.test(n)) exact.add(n);
    else {
      const body = n
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      wildcards.push(new RegExp(`^${body}$`, "s"));
    }
  }
  return { names, exact, wildcards };
}

export function isIgnoredName(name: string): boolean {
  const names = useProject.getState().settings?.files?.ignoredNames ?? DEFAULT_IGNORED_NAMES;
  const m = cached?.names === names ? cached : (cached = compile(names));
  return m.exact.has(name) || m.wildcards.some((re) => re.test(name));
}
