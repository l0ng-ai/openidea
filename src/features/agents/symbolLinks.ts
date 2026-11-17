/**
 * Symbol links in agent replies: the names a reply shows are looked up in the symbol index
 * in one batch, and each name only once per task folder.
 */
import { call, commands, type SymbolMatch } from "@/platform/ipc";
import type { SymbolRef } from "./conversation";

/** Index answers by the folder they were asked in, then by name. */
const answers = new Map<string, Map<string, Promise<SymbolMatch[]>>>();
const NAMES_PER_FOLDER = 2000;

/** The index's symbols named exactly each of `names` inside `within`; one request for the names not asked before. */
export function lookupSymbols(within: string, names: Iterable<string>): Map<string, Promise<SymbolMatch[]>> {
  const known = answers.get(within) ?? new Map<string, Promise<SymbolMatch[]>>();
  answers.set(within, known);
  const wanted = new Set(names);
  const missing = [...wanted].filter((name) => !known.has(name));
  if (missing.length) {
    const found = call(commands.findSymbolsNamed(missing, within)).catch(() => []);
    for (const name of missing) {
      if (known.size >= NAMES_PER_FOLDER) known.delete(known.keys().next().value!);
      known.set(
        name,
        found.then((symbols) => symbols.filter((symbol) => symbol.name === name)),
      );
    }
  }
  return new Map([...wanted].map((name) => [name, known.get(name)!]));
}

/** Narrows `symbols` by each preference in turn, skipping one that would leave nothing. */
function preferred(symbols: SymbolMatch[], ...preferences: Array<(symbol: SymbolMatch) => boolean>): SymbolMatch[] {
  return preferences.reduce((pool, prefers) => {
    const narrowed = pool.filter(prefers);
    return narrowed.length ? narrowed : pool;
  }, symbols);
}

const trimSlash = (path: string) => path.replace(/\/$/, "");
const under = (folder: string, path: string) => path.startsWith(`${trimSlash(folder)}/`);

/**
 * The definitions `ref` names among `symbols` (same name, kind, container and file), the
 * ones in a file the reply names first, then the ones in the task's folder `cwd`.
 */
export function symbolTargets(
  ref: SymbolRef,
  symbols: readonly SymbolMatch[],
  mentioned: readonly string[],
  cwd: string,
): SymbolMatch[] {
  const exact = symbols.filter(
    (symbol) =>
      symbol.name === ref.name &&
      ref.kinds.includes(symbol.kind) &&
      (!ref.container || symbol.container?.split(/\.|::/).pop() === ref.container) &&
      (!ref.file || symbol.path.endsWith(`/${ref.file}`)),
  );
  return preferred(
    exact,
    (symbol) => mentioned.some((path) => symbol.path.endsWith(`/${path.replace(/^\.?\//, "")}`)),
    (symbol) => under(cwd, symbol.path),
  );
}

/**
 * `symbol` as the task sees it: a task in a worktree outside the indexed project root has
 * the same file under its own folder.
 */
export function inTaskFolder(symbol: SymbolMatch, projectRoot: string, cwd: string): SymbolMatch {
  if (trimSlash(cwd) === trimSlash(projectRoot) || under(projectRoot, cwd)) return symbol;
  return { ...symbol, path: `${trimSlash(cwd)}/${symbol.relPath}` };
}
