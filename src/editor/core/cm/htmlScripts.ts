import { javascriptLanguage } from "@codemirror/lang-javascript";
import type { html } from "@codemirror/lang-html";

type NestedLanguages = NonNullable<NonNullable<Parameters<typeof html>[0]>["nestedLanguages"]>;

/**
 * `<script>` types that are JavaScript but that `@codemirror/lang-html` leaves as plain text:
 * versioned ones such as `text/ecmascript-6` (old Vue CLI templates) and `text/javascript1.5`.
 */
export const VERSIONED_SCRIPT_TYPES: NestedLanguages = [
  {
    tag: "script",
    attrs: (a) => /^(?:text|application)\/(?:x-)?(?:java|ecma)script-?\d+(?:\.\d+)?$/i.test(a.type ?? ""),
    parser: javascriptLanguage.parser,
  },
];
