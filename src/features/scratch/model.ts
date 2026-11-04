/** Pure parts of Scratch Files: naming and the language chooser list. */
import { fuzzyMatch } from "@/ui";

export interface ScratchLanguage {
  id: string;
  name: string;
  /** Extension (without the dot) new scratch files of this language get. */
  ext: string;
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
  langs: ReadonlyArray<{ id: string; name: string; extensions: readonly string[]; scratchTemplate?: string | null }>,
): ScratchLanguage[] {
  const out: ScratchLanguage[] = [];
  for (const l of langs) {
    const ext = l.extensions.find((e) => e.trim())?.replace(/^\./, "");
    if (ext) out.push({ id: l.id, name: l.name, ext, ...(l.scratchTemplate && { template: l.scratchTemplate }) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
