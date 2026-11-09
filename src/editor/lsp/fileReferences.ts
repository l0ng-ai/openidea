/**
 * File references while editing, in every language: path completion inside
 * `href="…"`, `src="…"`, `url(…)`, `@import "…"`, Markdown links and path-like
 * string literals (folders first; picking one continues into it), and the
 * "Cannot resolve file" warning on HTML / CSS paths that name no file.
 * Paths resolve in the backend like IDEA's file references: relative to the
 * file, `/…` against the project root and its resource roots.
 */
import {
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { whenSynced } from "@/editor/api";
import { call, commands, isTauri, onIdeEvent, type PathCompletion } from "@/platform/ipc";
import { fileIconName, folderIconName } from "@/ui";
import { setFileDiagnostics } from "./diagnostics";
import { docOf, lspDoc } from "./lsp";
import { tx } from "@/platform/i18n";

// --- completion ---------------------------------------------------------------

export interface PathContext {
  /** The path typed so far. */
  prefix: string;
  /** Whether to complete without an explicit request even when `prefix` does not look like a path yet. */
  eager: boolean;
}

const URL_ATTRIBUTE = /\b(?:href|src|srcset|action|formaction|poster|data|xlink:href)\s*=\s*["']?([^"'\s>]*)$/i;
const CSS_URL = /\burl\(\s*["']?([^"')\s]*)$/;
const CSS_IMPORT = /@(?:import|use|forward)\s+["']([^"']*)$/;
const MARKDOWN_LINK = /\]\(([^)\s]*)$/;
const STRING = /(["'`])([^"'`\\]*)$/;
/** Module specifiers: the language server completes those. */
const MODULE_SPECIFIER = /(?:\bimport\b|\bfrom\b|\brequire\s*\(|\bimport\s*\()\s*["'`][^"'`]*$/;
const JS_LIKE = new Set(["javascript", "typescript", "javascriptreact", "typescriptreact", "vue", "svelte"]);

/** Whether `prefix` already reads like a path (`./`, `../`, `a/b`). */
export const pathLike = (prefix: string) => /^\.{1,2}\/|\//.test(prefix);

/** The path being typed at the end of `before` (the line up to the caret), if any. */
export function pathContext(before: string, language: string): PathContext | null {
  for (const re of [URL_ATTRIBUTE, CSS_URL, CSS_IMPORT, MARKDOWN_LINK]) {
    const m = re.exec(before);
    if (m) return { prefix: m[1]!, eager: true };
  }
  const m = STRING.exec(before);
  if (!m) return null;
  // Inside a string only when the quote opens one (an odd count on the line).
  if ((before.split(m[1]!).length - 1) % 2 === 0) return null;
  if (JS_LIKE.has(language) && MODULE_SPECIFIER.test(before)) return null;
  return { prefix: m[2]!, eager: false };
}

const listings = new Map<string, { at: number; items: Promise<PathCompletion[]> }>();
const LISTING_TTL = 3000;

function listing(from: string, dirPrefix: string): Promise<PathCompletion[]> {
  const key = `${from}\n${dirPrefix}`;
  const hit = listings.get(key);
  if (hit && Date.now() - hit.at < LISTING_TTL) return hit.items;
  const items = call(commands.pathCompletions(from, dirPrefix)).catch(() => []);
  listings.set(key, { at: Date.now(), items });
  if (listings.size > 32) listings.delete(listings.keys().next().value!);
  return items;
}

function option(entry: PathCompletion): Completion & { icon: string } {
  if (!entry.dir) return { label: entry.name, type: "file", icon: fileIconName(entry.name), boost: -1 };
  return {
    label: `${entry.name}/`,
    type: "folder",
    icon: folderIconName(),
    apply: (view, _c, from, to) => {
      view.dispatch({
        changes: { from, to, insert: `${entry.name}/` },
        selection: { anchor: from + entry.name.length + 1 },
      });
      startCompletion(view);
    },
  };
}

export async function pathCompletionSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  const doc = ctx.state.facet(lspDoc);
  if (!doc || doc.virtual || doc.readOnly || !isTauri()) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const found = pathContext(line.text.slice(0, ctx.pos - line.from), doc.language);
  if (!found || /[?#]/.test(found.prefix)) return null;
  if (!ctx.explicit && !found.eager && !pathLike(found.prefix)) return null;
  const slash = found.prefix.lastIndexOf("/");
  const entries = await listing(doc.path, found.prefix.slice(0, slash + 1));
  if (ctx.aborted || !entries.length) return null;
  return {
    from: ctx.pos - (found.prefix.length - slash - 1),
    options: entries.map(option),
    validFor: /^[^/"'`)\s?#]*$/,
  };
}

// --- unresolved references --------------------------------------------------

const WEB_LANGUAGES = new Set(["html", "css", "scss", "less", "vue", "svelte"]);
const SOURCE = "file-references";
const INSPECT_DELAY = 600;

/** Warns about HTML / CSS paths that name no file; re-checked on edits and file-system changes. */
export function unresolvedReferences(): Extension {
  return ViewPlugin.define((view: EditorView) => {
    const doc = docOf(view);
    if (!doc || doc.virtual || !WEB_LANGUAGES.has(doc.language) || !isTauri()) return {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    const run = async () => {
      const mine = ++seq;
      try {
        await whenSynced(view);
        const refs = await call(commands.webUnresolvedReferences(doc.doc));
        if (mine !== seq) return;
        setFileDiagnostics(
          doc.path,
          SOURCE,
          refs.map((r) => ({
            range: r.range,
            severity: "warning",
            message: tx`Cannot resolve file '${r.value}'`,
            source: doc.language === "html" || doc.language === "vue" || doc.language === "svelte" ? "HTML" : "CSS",
            code: null,
          })),
        );
      } catch (e) {
        console.debug("[file references]", e);
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(), INSPECT_DELAY);
    };
    schedule();
    const offFs = onIdeEvent("fsChanged", (e) => {
      if (e.created.length || e.removed.length) schedule();
    });
    return {
      update: (u) => {
        if (u.docChanged) schedule();
      },
      destroy: () => {
        clearTimeout(timer);
        offFs();
        seq++;
        setFileDiagnostics(doc.path, SOURCE, []);
      },
    };
  });
}
