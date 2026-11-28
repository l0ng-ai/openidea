/**
 * Jinja2 templates: `@codemirror/lang-jinja` (template tags, variables and
 * comments; block folding and indentation; completion of tags, filters and
 * tests) over plain text, or over HTML for `.html.j2` and the like, with
 * `{# #}` comments in the markup too.
 */
import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { jinja as jinjaSupport } from "@codemirror/lang-jinja";
import { htmlLanguage } from "@codemirror/lang-html";

const JINJA_COMMENT = { block: { open: "{#", close: "#}" } };

// The text between the template tags of a config file, YAML or source: no syntax of its own.
const plainText = new LanguageSupport(
  StreamLanguage.define({
    name: "jinja-text",
    token(stream) {
      stream.skipToEnd();
      return null;
    },
  }),
);

/** A Jinja2 template of any text (Ansible's `nginx.conf.j2`, `values.yaml.j2`). */
export function jinja(): LanguageSupport {
  const support = jinjaSupport({ base: plainText });
  return new LanguageSupport(support.language, [
    support.support,
    plainText.language.data.of({ commentTokens: JINJA_COMMENT }),
    support.language.data.of({ commentTokens: JINJA_COMMENT }),
  ]);
}

/** A Jinja2 HTML template (`page.html.j2`, Flask's `base.html.jinja`). */
export function jinjaHtml(): LanguageSupport {
  const support = jinjaSupport(); // HTML is the default base
  return new LanguageSupport(support.language, [
    support.support,
    // Markup is commented out with a template comment, which Jinja drops from the page.
    htmlLanguage.data.of({ commentTokens: JINJA_COMMENT }),
    support.language.data.of({ commentTokens: JINJA_COMMENT }),
  ]);
}
