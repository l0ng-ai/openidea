/**
 * Project-level MyBatis index, built lazily from a Find in Files search for
 * `<mapper` in `*.xml` (the native engine, so no full-project read): namespace
 * → mapper XML files and their statements. @MapperScan packages are scanned
 * the same way, only when the annotation / namespace / SQL-annotation signals
 * did not already identify a mapper.
 *
 * The cache lives per project root; statements of *open* editors are read
 * from their live document text elsewhere, so the index only serves files
 * that are not open. It is rebuilt on cache miss triggers (project switch,
 * generation) — `shortcut: no incremental invalidation`.
 */
import { call, commands, nextRequestId, type RequestId } from "@/platform/ipc";
import { streamSearch } from "@/features/search/common/textSearch";
import { readManyFileLines } from "@/editor/lsp/files";
import { basename } from "@/platform/project";
import { parseMapperXml, type XmlStatement } from "./xmlParse";
import { parseMapperInterface, type MapperInterface } from "./javaParse";
import { mapperLocationDirs } from "./generate";

export interface XmlEntry {
  path: string;
  statements: Map<string, XmlStatement[]>;
}

export interface MapperIndex {
  /** namespace → mapper XML files. */
  xmls: Map<string, XmlEntry[]>;
}

export const EMPTY_INDEX: MapperIndex = { xmls: new Map() };

let cache: { root: string; promise: Promise<MapperIndex>; value: MapperIndex | null } | null = null;
let scanCache: { root: string; promise: Promise<string[]>; value: string[] | null } | null = null;

export function resetMapperIndex(): void {
  cache = null;
  scanCache = null;
}

/** The resolved index, when one already finished for `root` (sync, for intention providers). */
export function mapperIndexSnapshot(root: string | null): MapperIndex | null {
  return cache && cache.root === root ? cache.value : null;
}

/** The resolved @MapperScan packages, when scanned for `root` (sync). */
export function mapperScanPackagesSnapshot(root: string | null): string[] | null {
  return scanCache && scanCache.root === root ? scanCache.value : null;
}

/**
 * Merges the live text of a mapper XML into the resolved index, so a freshly
 * generated (possibly unsaved) statement shows up in the Java gutter at once.
 * The generation flow always `await`s `ensureMapperIndex` first, so the cache
 * is resolved here; without that, the next ensure() rebuild covers the file.
 */
export function patchMapperIndex(path: string, text: string): void {
  if (!cache || !cache.value) return;
  const xml = parseMapperXml(text);
  if (!xml.namespace) return;
  const entry: XmlEntry = { path, statements: new Map() };
  for (const s of xml.statements) {
    const list = entry.statements.get(s.id);
    if (list) list.push(s);
    else entry.statements.set(s.id, [s]);
  }
  const entries = cache.value.xmls.get(xml.namespace) ?? [];
  cache.value.xmls.set(xml.namespace, [...entries.filter((e) => e.path !== path), entry]);
}

const MAX_XML_FILES = 200;
const MAX_JAVA_FILES = 100;

/** Paths of files whose content matches `pattern` under the `include` masks; null when the search itself failed. */
async function searchPaths(pattern: string, include: string[]): Promise<string[] | null> {
  const request: RequestId = nextRequestId();
  const paths: string[] = [];
  try {
    await streamSearch(
      request,
      {
        pattern,
        isRegex: false,
        caseSensitive: false,
        wholeWord: false,
        include,
        exclude: [],
        scope: { kind: "project" },
        maxMatches: 0,
      },
      (f) => paths.push(f.path),
    );
    return paths;
  } catch {
    return null;
  }
}

async function build(): Promise<MapperIndex> {
  const index: MapperIndex = { xmls: new Map() };
  const found = await searchPaths("<mapper", ["*.xml"]);
  // A failed search must not pass for "no mappers": the caller retries later.
  if (found === null) throw new Error("mapper XML search failed");
  const paths = found.slice(0, MAX_XML_FILES);
  const lines = await readManyFileLines(paths, 6);
  for (const path of paths) {
    const fileLines = lines.get(path);
    if (!fileLines) continue;
    const xml = parseMapperXml(fileLines.join("\n"));
    if (!xml.namespace) continue;
    const entry: XmlEntry = { path, statements: new Map() };
    for (const s of xml.statements) {
      const list = entry.statements.get(s.id);
      if (list) list.push(s);
      else entry.statements.set(s.id, [s]);
    }
    const list = index.xmls.get(xml.namespace);
    if (list) list.push(entry);
    else index.xmls.set(xml.namespace, [entry]);
  }
  return index;
}

/** The (cached) project index; empty when there is no project or the search fails (not cached, retried). */
export function ensureMapperIndex(root: string | null): Promise<MapperIndex> {
  if (!root) return Promise.resolve(EMPTY_INDEX);
  if (cache && cache.root === root) return cache.promise;
  const promise = build()
    .then((index) => {
      if (cache && cache.promise === promise) cache.value = index;
      return index;
    })
    .catch(() => {
      // Drop the cache so the next pass (edit, focus, file change) retries.
      if (cache && cache.promise === promise) cache = null;
      return EMPTY_INDEX;
    });
  cache = { root, promise, value: null };
  return promise;
}

const BASE_PACKAGES = /basePackages\s*=\s*(\{[^}]*\}|"[^"]*")/;
const STRING_LIT = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;

/**
 * Packages that a `@MapperScan` covers, found by a project search over
 * `*.java` (`basePackages` strings; a scan without `basePackages` covers the
 * declaring class's package). `shortcut: basePackageClasses not resolved`.
 */
export function ensureMapperScanPackages(root: string | null): Promise<string[]> {
  if (!root) return Promise.resolve([]);
  if (scanCache && scanCache.root === root) return scanCache.promise;
  const promise = (async () => {
    const packages = new Set<string>();
    const found = await searchPaths("@MapperScan", ["*.java"]);
    if (found === null) throw new Error("@MapperScan search failed");
    const paths = found.slice(0, MAX_JAVA_FILES);
    const lines = await readManyFileLines(paths, 6);
    for (const path of paths) {
      const fileLines = lines.get(path);
      if (!fileLines) continue;
      const text = fileLines.join("\n");
      const m = BASE_PACKAGES.exec(text);
      if (m && m[1]) {
        for (const lit of m[1].matchAll(STRING_LIT)) if (lit[1]) packages.add(lit[1]);
      } else {
        const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text);
        if (pkg) packages.add(pkg[1]!);
      }
    }
    return [...packages];
  })().then(
    (packages) => {
      if (scanCache && scanCache.promise === promise) scanCache.value = packages;
      return packages;
    },
    () => {
      // Drop the cache so the next pass retries.
      if (scanCache && scanCache.promise === promise) scanCache = null;
      return [];
    },
  );
  scanCache = { root, promise, value: null };
  return promise;
}

/** Whether a `@MapperScan` somewhere covers `pkg`. */
export function mapperScanCovers(packages: readonly string[], pkg: string): boolean {
  return packages.some((p) => pkg === p || pkg.startsWith(`${p}.`));
}

// ---------------------------------------------------------------------------
// Counterparts

/**
 * The interface of a mapper XML namespace, by name search + package check.
 * Prefers the live document of an open editor (callers may pass one).
 */
export async function javaInterfaceFor(
  namespace: string,
  openText?: { path: string; text: string } | null,
): Promise<{ path: string; iface: MapperInterface } | null> {
  if (openText) {
    const iface = parseMapperInterface(openText.text);
    if (iface && iface.fqn === namespace) return { path: openText.path, iface };
    return null;
  }
  const name = namespace.slice(namespace.lastIndexOf(".") + 1);
  const found = await call(commands.findFiles(`${name}.java`, 8)).catch(() => []);
  for (const m of found) {
    if (basename(m.path) !== `${name}.java`) continue;
    const text = await call(commands.fsReadText(m.path)).catch(() => null);
    if (text === null) continue;
    const iface = parseMapperInterface(text);
    if (iface && iface.fqn === namespace) return { path: m.path, iface };
  }
  return null;
}

const CONFIG_NAME = /^application(?:-[^.]*)?\.(?:yml|yaml|properties)$/;

/**
 * Directories of Spring's `mybatis.mapper-locations` across the project's
 * application configs (multi-module included); empty without the setting.
 */
export async function configuredXmlDirs(): Promise<string[]> {
  const found = await call(commands.findFiles("application", 40)).catch(() => []);
  const dirs = new Set<string>();
  for (const m of found) {
    if (!CONFIG_NAME.test(basename(m.path))) continue;
    const text = await call(commands.fsReadText(m.path)).catch(() => null);
    if (text === null) continue;
    for (const d of mapperLocationDirs(text)) dirs.add(d);
  }
  return [...dirs];
}
