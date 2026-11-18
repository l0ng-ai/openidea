/**
 * Settings › Editor › File Types: the user's file name / hashbang patterns per
 * language (`files.fileTypes`) and per-file Override File Type
 * (`files.fileTypeOverrides`, project scope). The backend registry
 * (`ide-language`) detects languages with them; this module holds the shared
 * model and mirrors the name matching for the UI (file icons).
 */
import type { LanguageInfo_Serialize as LanguageInfo } from "./ipc";
import { useProject } from "./project";

export interface FileTypeAssociation {
  /** Added file name patterns (`*.foo`, `Jenkinsfile`, `Dockerfile.*`). */
  patterns: string[];
  /** Patterns of the language definition the user removed. */
  removedPatterns: string[];
  /** Interpreters run by a `#!` first line (`node`). */
  hashbangs: string[];
}

export type FileTypeAssociations = Record<string, FileTypeAssociation>;

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ]
    : [];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function validateFileTypes(raw: unknown): FileTypeAssociations {
  const out: FileTypeAssociations = {};
  if (!isObj(raw)) return out;
  for (const [id, a] of Object.entries(raw)) {
    if (!id.trim() || !isObj(a)) continue;
    out[id] = {
      patterns: strings(a.patterns),
      removedPatterns: strings(a.removedPatterns),
      hashbangs: strings(a.hashbangs),
    };
  }
  return out;
}

export function validateFileTypeOverrides(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [path, lang] of Object.entries(raw))
    if (path.trim() && typeof lang === "string" && lang.trim()) out[path] = lang.trim();
  return out;
}

/** Settings key of a file: project-relative inside the project, else absolute. */
export function overrideKey(path: string, root: string | null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** Built-in file name patterns of a language definition: `*.ext` and file names. */
export function builtinPatterns(lang: Pick<LanguageInfo, "extensions" | "filenames">): string[] {
  return [...lang.extensions.map((e) => `*.${e}`), ...(lang.filenames ?? [])];
}

const EMPTY: FileTypeAssociation = { patterns: [], removedPatterns: [], hashbangs: [] };

/** Effective file name patterns of a language: definition minus removed, plus added. */
export function effectivePatterns(
  lang: Pick<LanguageInfo, "id" | "extensions" | "filenames">,
  assoc: FileTypeAssociations,
): Array<{ pattern: string; builtin: boolean }> {
  const own = assoc[lang.id] ?? EMPTY;
  const removed = new Set(own.removedPatterns.map((p) => p.toLowerCase()));
  const out = builtinPatterns(lang)
    .filter((p) => !removed.has(p.toLowerCase()))
    .map((pattern) => ({ pattern, builtin: true }));
  for (const pattern of own.patterns)
    if (!out.some((o) => o.pattern === pattern)) out.push({ pattern, builtin: false });
  return out;
}

function withAssoc(assoc: FileTypeAssociations, id: string, f: (a: FileTypeAssociation) => FileTypeAssociation) {
  const next = { ...assoc, [id]: f(assoc[id] ?? EMPTY) };
  const a = next[id]!;
  if (!a.patterns.length && !a.removedPatterns.length && !a.hashbangs.length) delete next[id];
  return next;
}

/**
 * Adds `pattern` to `id`. As in IDEA a pattern belongs to one file type: it is
 * taken away from any other language that has it (built-in or added).
 */
export function addPattern(
  assoc: FileTypeAssociations,
  langs: ReadonlyArray<Pick<LanguageInfo, "id" | "extensions" | "filenames">>,
  id: string,
  pattern: string,
): FileTypeAssociations {
  const p = pattern.trim();
  if (!p) return assoc;
  let next = assoc;
  for (const l of langs) {
    if (l.id === id || !effectivePatterns(l, next).some((e) => e.pattern === p)) continue;
    next = removePattern(next, l, p);
  }
  const lang = langs.find((l) => l.id === id);
  return withAssoc(next, id, (a) => {
    // Re-adding a removed built-in pattern restores it.
    if (lang && builtinPatterns(lang).includes(p))
      return { ...a, removedPatterns: a.removedPatterns.filter((r) => r !== p) };
    return a.patterns.includes(p) ? a : { ...a, patterns: [...a.patterns, p] };
  });
}

export function removePattern(
  assoc: FileTypeAssociations,
  lang: Pick<LanguageInfo, "id" | "extensions" | "filenames">,
  pattern: string,
): FileTypeAssociations {
  const builtin = builtinPatterns(lang).includes(pattern);
  return withAssoc(assoc, lang.id, (a) => ({
    ...a,
    patterns: a.patterns.filter((p) => p !== pattern),
    removedPatterns:
      builtin && !a.removedPatterns.includes(pattern) ? [...a.removedPatterns, pattern] : a.removedPatterns,
  }));
}

export function setHashbangs(assoc: FileTypeAssociations, id: string, hashbangs: string[]): FileTypeAssociations {
  return withAssoc(assoc, id, (a) => ({ ...a, hashbangs: strings(hashbangs) }));
}

/** `*` matches any run of characters, `?` one (as `ide-language`'s file name patterns). */
export function wildcardMatch(pattern: string, name: string): boolean {
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "s",
  );
  return re.test(name);
}

/** Language a user-added pattern assigns to `fileName` (null: none applies). */
export function userFileType(assoc: FileTypeAssociations, fileName: string): string | null {
  const lower = fileName.toLowerCase();
  let glob: { id: string; len: number } | null = null;
  let ext: { id: string; len: number } | null = null;
  for (const [id, a] of Object.entries(assoc)) {
    for (const p of a.patterns) {
      const simpleExt = /^\*\.[^*?]+$/.test(p);
      if (!/[*?]/.test(p)) {
        if (p === fileName) return id;
      } else if (simpleExt) {
        const e = p.slice(1).toLowerCase();
        if (lower.endsWith(e) && lower.length > e.length && (!ext || e.length > ext.len)) ext = { id, len: e.length };
      } else if (wildcardMatch(p, fileName) && (!glob || p.length > glob.len)) glob = { id, len: p.length };
    }
  }
  return glob?.id ?? ext?.id ?? null;
}

/**
 * Whether Settings › File Types leave `path` in one of `languages`, decided without asking the
 * backend. Same order as `LanguageRegistry::detect`: Override File Type, the user's patterns,
 * then the built-in `extensions` they did not remove. Hashbangs and first lines need the content.
 */
export function hasFileType(
  path: string,
  languages: readonly string[],
  extensions: ReadonlySet<string>,
  files: { fileTypes?: unknown; fileTypeOverrides?: unknown } | undefined,
  root: string | null,
): boolean {
  const assoc = validateFileTypes(files?.fileTypes);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const assigned =
    validateFileTypeOverrides(files?.fileTypeOverrides)[overrideKey(path, root)] ?? userFileType(assoc, name);
  if (assigned) return languages.includes(assigned);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const pattern = `*${name.slice(dot).toLowerCase()}`;
  return (
    extensions.has(pattern.slice(2)) &&
    !languages.some((l) => assoc[l]?.removedPatterns.some((p) => p.toLowerCase() === pattern))
  );
}

const fileTypesKey = ({ settings }: ReturnType<typeof useProject.getState>) =>
  JSON.stringify([settings?.files?.fileTypes, settings?.files?.fileTypeOverrides]);

/** Calls `listener` when Settings › File Types (associations or overrides) change. */
export function onFileTypesChange(listener: () => void): () => void {
  return useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings && fileTypesKey(s) !== fileTypesKey(prev)) listener();
  });
}

/** File name standing for a language when picking its icon (`x.py`). */
export function sampleFileName(lang: Pick<LanguageInfo, "extensions" | "filenames">): string | null {
  if (lang.extensions[0]) return `file.${lang.extensions[0]}`;
  return lang.filenames?.find((n) => !/[*?]/.test(n)) ?? null;
}
