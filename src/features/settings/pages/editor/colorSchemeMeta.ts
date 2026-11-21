import { ATTRIBUTES } from "@/platform/colorScheme";

export const LANGUAGES = [...new Set(ATTRIBUTES.map((a) => a.path[0]!))].filter(
  (s) => !["General", "Debugger", "Language Defaults", "Console Colors", "Git", "Diff & Merge"].includes(s),
);

/** A sub-page id: `C#` → `csharp`, `Diff & Merge` → `diff-and-merge` (`#`/`&` end a settings link). */
export const languagePageId = (language: string) =>
  `editor.colorScheme.${language
    .toLowerCase()
    .replace(/#/g, "sharp")
    .replace(/&/g, "and")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")}`;

/** Sub-pages linked from the Color Scheme landing page, in sidebar order. */
export const SCHEME_SUBPAGES = [
  { id: "editor.colorScheme.general", title: "General" },
  { id: "editor.colorScheme.language-defaults", title: "Language Defaults" },
  { id: "editor.colorScheme.debugger", title: "Debugger" },
  { id: "editor.colorScheme.console-colors", title: "Console Colors" },
  { id: "editor.colorScheme.git", title: "Git" },
  { id: "editor.colorScheme.diff-and-merge", title: "Diff & Merge" },
  ...LANGUAGES.map((l) => ({ id: languagePageId(l), title: l })),
];
