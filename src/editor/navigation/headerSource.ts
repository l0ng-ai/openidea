/** Related Symbol for C, C++, Objective-C and CUDA: a header and its source files, by name. */
import type { RelatedItem } from "@/editor/relatedProviders";
import { tx } from "@/platform/i18n";

const HEADERS = ["h", "hh", "hpp", "hxx", "h++", "cuh"];
const SOURCES = ["c", "cc", "cpp", "cxx", "c++", "m", "mm", "cu"];

function split(path: string): { dir: string; stem: string; ext: string } | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return { dir: path.slice(0, slash), stem: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() };
}

/** The file names whose stem matches `path`'s on the other side (header ↔ source), or none. */
export function counterpartNames(path: string): { names: string[]; group: string } | null {
  const parts = split(path);
  if (!parts) return null;
  if (HEADERS.includes(parts.ext)) return { names: SOURCES.map((e) => `${parts.stem}.${e}`), group: tx("Source") };
  if (SOURCES.includes(parts.ext)) return { names: HEADERS.map((e) => `${parts.stem}.${e}`), group: tx("Header") };
  return null;
}

function sharedPrefix(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/**
 * The counterparts of `path` among `candidates`: those in its own folder when there are any
 * (the pair to switch to), else all of them, nearest folders first.
 */
export function rankCounterparts(path: string, candidates: readonly string[]): string[] {
  const dir = split(path)?.dir ?? "";
  const unique = [...new Set(candidates)].filter((c) => c !== path);
  const local = unique.filter((c) => split(c)?.dir === dir);
  if (local.length) return local;
  return unique.sort((a, b) => sharedPrefix(path, b) - sharedPrefix(path, a) || a.localeCompare(b));
}

export async function headerSourceItems(
  path: string,
  findNamed: (name: string) => Promise<string[]>,
): Promise<RelatedItem[]> {
  const counterpart = counterpartNames(path);
  if (!counterpart) return [];
  const found = await Promise.all(counterpart.names.map((n) => findNamed(n).catch(() => [] as string[])));
  return rankCounterparts(path, found.flat()).map((p) => ({ path: p, group: counterpart.group }));
}
