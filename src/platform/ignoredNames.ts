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

interface Compiled {
  names: readonly string[];
  exact: Set<string>;
  suffixes: string[];
  wildcards: RegExp | null;
}

let cached: Compiled | null = null;

function compile(names: readonly string[]): Compiled {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  const patterns: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n || n.includes("/")) continue;
    if (!/[*?]/.test(n)) exact.add(n);
    // `*.pyc` (every default pattern): a suffix test, without a regex that retries `.*` at each position.
    else if (/^\*[^*?]+$/.test(n)) suffixes.push(n.slice(1));
    else {
      const body = n
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");
      patterns.push(body);
    }
  }
  // One alternation: a folder of thousands of entries tests each name once, not once per pattern.
  const wildcards = patterns.length ? new RegExp(`^(?:${patterns.join("|")})$`, "s") : null;
  return { names, exact, suffixes, wildcards };
}

export function isIgnoredName(name: string): boolean {
  const names = useProject.getState().settings?.files?.ignoredNames ?? DEFAULT_IGNORED_NAMES;
  const m = cached?.names === names ? cached : (cached = compile(names));
  return m.exact.has(name) || m.suffixes.some((s) => name.endsWith(s)) || !!m.wildcards?.test(name);
}
