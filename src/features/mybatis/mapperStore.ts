/**
 * The other half of a mapper: the XML file whose `<mapper namespace>` names a
 * Java interface, and the interface an XML namespace names.
 *
 * Nothing is scanned when the project opens. A namespace is resolved the first
 * time an editor asks for it — one Find in Files for the XML, one file-name
 * lookup for the interface — and the answer, positive or negative, is cached per
 * namespace. The cache is dropped when the project's Java or XML files change,
 * so creating the missing half lights up its gutter icon without a restart.
 *
 * The lookups are behind `MapperIndexDeps` so the resolution rules can be tested
 * without a backend, the way `implementationGutter` injects its LSP access.
 */
import { streamSearch } from "@/features/search/common/textSearch";
import { basename, useProject } from "@/platform/project";
import { call, commands, nextRequestId, onIdeEvent, type SearchQuery } from "@/platform/ipc";
import { parseJavaMapper, type JavaMapper } from "./java";
import { parseMapperXml, type MapperXml } from "./xml";

/** A counterpart file, with the text it was parsed from. */
export interface Found<T> {
  path: string;
  /** The file's text, for turning the parse's offsets into line/col. */
  text: string;
  parsed: T;
}

export interface MapperIndexDeps {
  /** Paths of the project's files containing `needle` as text. */
  search: (needle: string, include: readonly string[]) => Promise<string[]>;
  /** Paths of the project's files named exactly `name`. */
  byName: (name: string) => Promise<string[]>;
  /** File text, or null when it cannot be read. */
  read: (path: string) => Promise<string | null>;
}

const MAX_CANDIDATES = 200;

export const defaultMapperIndexDeps: MapperIndexDeps = {
  search: (needle, include) => {
    const request = nextRequestId();
    const query: SearchQuery = {
      pattern: needle,
      isRegex: false,
      caseSensitive: true,
      wholeWord: false,
      include: [...include],
      exclude: [],
      scope: { kind: "project" },
      maxMatches: MAX_CANDIDATES,
    };
    const paths: string[] = [];
    return streamSearch(request, query, (file) => paths.push(String(file.path))).then(() => paths);
  },
  byName: async (name) => {
    const matches = await call(commands.findFiles(name, MAX_CANDIDATES));
    return matches.filter((m) => basename(String(m.path)) === name).map((m) => String(m.path));
  },
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};

const xmlCache = new Map<string, Promise<Found<MapperXml> | null>>();
const javaCache = new Map<string, Promise<Found<JavaMapper> | null>>();
const cleared = new Set<() => void>();

/** The mapper XML declaring `qualifiedName` as its namespace; null when none does. */
export function mapperXmlFor(qualifiedName: string, deps: MapperIndexDeps = defaultMapperIndexDeps) {
  return cached(xmlCache, qualifiedName, () => findByNamespace(qualifiedName, deps));
}

/** The Java interface `qualifiedName` (the namespace of an open mapper XML). */
export function mapperInterfaceFor(qualifiedName: string, deps: MapperIndexDeps = defaultMapperIndexDeps) {
  return cached(javaCache, qualifiedName, () => findByInterface(qualifiedName, deps));
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let promise = cache.get(key);
  if (!promise) cache.set(key, (promise = load()));
  return promise;
}

async function findByNamespace(qualifiedName: string, deps: MapperIndexDeps): Promise<Found<MapperXml> | null> {
  const paths = await deps.search(qualifiedName, ["*.xml"]).catch(() => []);
  for (const path of paths) {
    const text = await deps.read(path);
    if (!text) continue;
    const parsed = parseMapperXml(text);
    if (parsed?.namespace === qualifiedName) return { path, text, parsed };
  }
  return null;
}

async function findByInterface(qualifiedName: string, deps: MapperIndexDeps): Promise<Found<JavaMapper> | null> {
  const simpleName = qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);
  const paths = await deps.byName(`${simpleName}.java`).catch(() => []);
  for (const path of paths) {
    const text = await deps.read(path);
    if (!text) continue;
    const parsed = parseJavaMapper(text);
    if (parsed?.qualifiedName === qualifiedName) return { path, text, parsed };
  }
  return null;
}

/** Java and XML edits can both add, rename or remove one half of a mapper. */
const MAPPER_SOURCE = /\.(?:java|xml)$/i;

export function clearMapperIndex() {
  xmlCache.clear();
  javaCache.clear();
  for (const fn of [...cleared]) fn();
}

/** Called after the cache is dropped, so the open editors ask again. */
export function onMapperIndexCleared(fn: () => void): () => void {
  cleared.add(fn);
  return () => void cleared.delete(fn);
}

/** Keeps the cache in step with the project; returns the disposer. */
export function installMapperIndex(): () => void {
  const offChanges = onIdeEvent("fsChanged", (event) => {
    const touched = [...event.created, ...event.modified, ...event.removed];
    if (touched.some((path) => MAPPER_SOURCE.test(String(path)))) clearMapperIndex();
  });
  const offProject = useProject.subscribe((state, previous) => {
    if (state.project?.root !== previous.project?.root) clearMapperIndex();
  });
  return () => {
    offChanges();
    offProject();
    clearMapperIndex();
  };
}
