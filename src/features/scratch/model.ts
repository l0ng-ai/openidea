/** Pure parts of Scratch Files: naming, language selection and the chooser list. */
import { fuzzyMatch } from "@/ui";

export interface ScratchLanguage {
  id: string;
  name: string;
  /** Extension (without the dot) new scratch files of this language get. */
  ext: string;
  /** Every extension the language claims, for matching a selection's source file. */
  extensions: readonly string[];
  /** First-line pattern used to recognise fragments such as hashbang scripts. */
  firstLine?: string;
  /** Initial content; `$END$` marks where the caret goes. */
  template?: string;
}

/** IDEA's names: `scratch.<ext>`, then `scratch_1.<ext>`, `scratch_2.<ext>`… */
export function scratchFileName(existing: Iterable<string>, ext: string): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  const suffix = ext ? `.${ext}` : "";
  if (!taken.has(`scratch${suffix}`.toLowerCase())) return `scratch${suffix}`;
  for (let i = 1; ; i++) {
    const name = `scratch_${i}${suffix}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Languages a scratch file can be created for (those with an extension), by name. */
export function scratchLanguages(
  langs: ReadonlyArray<{
    id: string;
    name: string;
    extensions: readonly string[];
    firstLine?: string | null;
    scratchTemplate?: string | null;
  }>,
): ScratchLanguage[] {
  const out: ScratchLanguage[] = [];
  for (const l of langs) {
    const extensions = l.extensions.map((e) => e.trim().replace(/^\./, "")).filter(Boolean);
    const ext = extensions[0];
    if (ext)
      out.push({
        id: l.id,
        name: l.name,
        ext,
        extensions,
        ...(l.firstLine && { firstLine: l.firstLine }),
        ...(l.scratchTemplate && { template: l.scratchTemplate }),
      });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

const normalExt = (ext: string) => ext.trim().replace(/^\./, "").toLowerCase();

/** High-confidence syntax fingerprints; ambiguous prose keeps the source file's language. */
function inferFragmentLanguage(text: string, byId: ReadonlyMap<string, ScratchLanguage>): ScratchLanguage | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  for (const lang of byId.values()) {
    if (!lang.firstLine) continue;
    try {
      if (new RegExp(lang.firstLine).test(firstLine)) return lang;
    } catch {
      // A plugin's invalid pattern must not stop the source-language fallback.
    }
  }

  const fragment = text.trim();
  if (!fragment) return undefined;
  if (/^[{[]/.test(fragment)) {
    try {
      JSON.parse(fragment);
      return byId.get("json");
    } catch {
      // Object literals and incomplete fragments are not necessarily JSON.
    }
  }
  if (/^<\?xml\b/i.test(fragment)) return byId.get("xml");
  if (/^<!doctype\s+html\b|^<(?:html|head|body|div|span|main|section|script|style)\b/i.test(fragment))
    return byId.get("html");
  if (
    /^(?:select\b[\s\S]+\bfrom\b|insert\s+into\b|update\b[\s\S]+\bset\b|delete\s+from\b|create\s+(?:table|view|index)\b|with\b[\s\S]+\bselect\b)/i.test(
      fragment,
    )
  )
    return byId.get("sql");
  if (/^(?:async\s+def\s+\w+\s*\(|def\s+\w+\s*\([^)]*\)\s*(?:->[^:]+)?:|from\s+[\w.]+\s+import\s+)/m.test(fragment))
    return byId.get("python");
  if (
    /^(?:package\s+[\w.]+\s*;|import\s+(?:java|javax)\.|(?:public|protected|private)\s+(?:\w+\s+)*(?:class|interface|enum|record)\s+)/m.test(
      fragment,
    )
  )
    return byId.get("java");
  if (/^package\s+\w+\s*$/m.test(fragment) || /^func\s+(?:\([^)]*\)\s*)?\w+\s*\(/m.test(fragment))
    return byId.get("go");
  if (/^(?:fn\s+\w+\s*\(|use\s+(?:std|core|alloc)::|pub\s+(?:struct|enum|trait|fn)\s+)/m.test(fragment))
    return byId.get("rust");
  if (/^#\s*include\s*[<"]/m.test(fragment))
    return /\b(?:std::|iostream|vector|string)\b/.test(fragment) ? byId.get("cpp") : byId.get("c");
  if (
    /^(?:console\.log\s*\(|import\s+.+\s+from\s+["']|export\s+(?:default\s+)?(?:function|const|class)\b)/m.test(
      fragment,
    )
  )
    return byId.get("javascript");
  return undefined;
}

/** Language for a selection: recognise the fragment, then its source language, extension, or plain text. */
export function scratchLanguageForSelection(
  source: { language: string; path: string },
  text: string,
  languages: readonly ScratchLanguage[],
): ScratchLanguage | null {
  const byId = new Map(languages.map((lang) => [lang.id.toLowerCase(), lang]));
  const inferred = inferFragmentLanguage(text, byId);
  if (inferred) return inferred;
  const sourceLanguage = byId.get(source.language.toLowerCase());
  if (sourceLanguage) return sourceLanguage;

  const name = source.path.slice(source.path.lastIndexOf("/") + 1).toLowerCase();
  for (let rest = name, dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
    rest = rest.slice(dot + 1);
    const matched = languages.find((lang) => lang.extensions.some((ext) => normalExt(ext) === rest));
    if (matched) return matched;
  }
  return byId.get("plaintext") ?? languages.find((lang) => lang.ext === "txt") ?? null;
}

const CARET = "$END$";

/** A new scratch file's text and caret (0-based line, UTF-16 column) from its language's template. */
export function scratchContent(template: string | undefined): {
  text: string;
  caret: { line: number; col: number } | null;
} {
  if (!template) return { text: "", caret: null };
  const at = template.indexOf(CARET);
  if (at < 0) return { text: template, caret: null };
  const before = template.slice(0, at);
  const lines = before.split("\n");
  return {
    text: before + template.slice(at + CARET.length).replaceAll(CARET, ""),
    caret: { line: lines.length - 1, col: lines[lines.length - 1]!.length },
  };
}

export interface LanguageRow {
  lang: ScratchLanguage;
  matches: number[] | null;
}

/**
 * Chooser rows: recently used languages first (most recent first) when not
 * filtering; with a filter, prefix matches of the name, then fuzzy matches,
 * then extension matches.
 */
export function chooserRows(
  langs: readonly ScratchLanguage[],
  recent: readonly string[],
  filter: string,
): LanguageRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) {
    const byId = new Map(langs.map((l) => [l.id, l]));
    const head = recent.map((id) => byId.get(id)).filter((l): l is ScratchLanguage => !!l);
    const seen = new Set(head.map((l) => l.id));
    return [...head, ...langs.filter((l) => !seen.has(l.id))].map((lang) => ({ lang, matches: null }));
  }
  const prefix: LanguageRow[] = [];
  const fuzzy: LanguageRow[] = [];
  const ext: LanguageRow[] = [];
  for (const lang of langs) {
    if (lang.name.toLowerCase().startsWith(q)) prefix.push({ lang, matches: [...Array(q.length).keys()] });
    else {
      const m = fuzzyMatch(lang.name, q);
      if (m) fuzzy.push({ lang, matches: m });
      else if (lang.ext.toLowerCase().startsWith(q) || lang.id.toLowerCase().startsWith(q))
        ext.push({ lang, matches: null });
    }
  }
  return [...prefix, ...fuzzy, ...ext];
}

export const MAX_RECENT = 5;

export function pushRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
}
