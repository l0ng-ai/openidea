/** Markdown → sanitized HTML (marked + DOMPurify); loaded on demand by `markdown.ts`. */
import { Marked } from "marked";
import DOMPurify from "dompurify";

/** DOMPurify's default link schemes plus `file:` and jdtls' `jdt:` (library classes). */
const ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|file|jdt):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const marked = new Marked({ gfm: true, breaks: false });

export function markdownToSafeHtml(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  // Comments and docs come from anyone; a `<style>` here would restyle the whole IDE.
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style"],
  });
}
