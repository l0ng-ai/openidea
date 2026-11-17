/**
 * Vue single-file components: `@codemirror/lang-vue`'s parser over an HTML
 * base that also highlights `<style lang="scss|sass">` with the Sass grammar —
 * stock `vue()` parses every `<style>` as plain CSS, which loses the SCSS
 * colours.
 */
import { indentNodeProp, LanguageSupport, type LRLanguage, type TreeIndentContext } from "@codemirror/language";
import { html } from "@codemirror/lang-html";
import { sassLanguage } from "@codemirror/lang-sass";
import { vue } from "@codemirror/lang-vue";

/**
 * WebStorm's Vue code style indents the children of the top-level `<template>` only: code in
 * `<script setup>` or `<style>` starts at the margin, as `npm create vue` writes it.
 */
function elementIndent(context: TreeIndentContext): number | null {
  const after = /^(\s*)(<\/)?/.exec(context.textAfter)!;
  const node = context.node;
  if (node.to <= context.pos + after[0].length) return context.continue();
  const tag = node.firstChild?.getChild("TagName");
  const flat =
    node.parent?.name === "Document" && !!tag && context.state.sliceDoc(tag.from, tag.to).toLowerCase() !== "template";
  return context.lineIndent(node.from) + (after[2] || flat ? 0 : context.unit);
}

export function vueLanguage(): LanguageSupport {
  const base = html({
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
  });
  const language = (base.language as LRLanguage).configure({ props: [indentNodeProp.add({ Element: elementIndent })] });
  return vue({ base: new LanguageSupport(language, base.support) });
}
