/**
 * Jinja2 templates: `@codemirror/lang-jinja` (template tags, variables and
 * comments over HTML; block folding and indentation; completion of tags,
 * filters and tests), with `{# #}` comments in the markup too.
 */
import { LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { htmlLanguage } from "@codemirror/lang-html";

const JINJA_COMMENT = { block: { open: "{#", close: "#}" } };

export async function jinja(): Promise<LanguageSupport> {
  const support = await languages.find((l) => l.name === "Jinja")!.load();
  return new LanguageSupport(support.language, [
    support.support,
    // Markup is commented out with a template comment, which Jinja drops from the page.
    htmlLanguage.data.of({ commentTokens: JINJA_COMMENT }),
    support.language.data.of({ commentTokens: JINJA_COMMENT }),
  ]);
}
