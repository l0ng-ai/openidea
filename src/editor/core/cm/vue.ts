/**
 * Vue single-file components: `@codemirror/lang-vue`'s parser over an HTML
 * base that also highlights `<style lang="scss|sass">` with the Sass grammar —
 * stock `vue()` parses every `<style>` as plain CSS, which loses the SCSS
 * colours.
 */
import { LanguageSupport } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { sassLanguage } from "@codemirror/lang-sass";
import { vue } from "@codemirror/lang-vue";

export function vueLanguage(): LanguageSupport {
  return vue({
    base: html({
      selfClosingTags: true,
      // `<style>` without `lang` (or with `lang="css"`) keeps HTML's own CSS
      // nesting; only an explicit SCSS/Sass dialect re-parses it.
      nestedLanguages: [
        {
          tag: "style",
          attrs: (a) => a.lang === "scss" || a.lang === "sass",
          parser: sassLanguage.parser,
        },
      ],
    }),
  });
}
