import { ATTRIBUTES, SCHEMES } from "@/platform/colorScheme";
import { lazyPage } from "../lazyPage";
import type { PageSpec } from "../spec";
import { LANGUAGES, SCHEME_SUBPAGES, languagePageId } from "./colorSchemeMeta";
import { editorPage } from "./kit";

const ALL_COLOR_SCHEME_PAGE_IDS = ["editor.colorScheme", ...SCHEME_SUBPAGES.map((p) => p.id)];
const LazyColorSchemePage = lazyPage(ALL_COLOR_SCHEME_PAGE_IDS, () =>
  import("./ColorSchemeBody").then((m) => m.ColorSchemePage),
);

/** The scope chooser, import/export buttons and preview are identical on every sub-page. */
function colorSchemeSection(scopes: readonly string[]) {
  return {
    items: [
      {
        t: "custom" as const,
        label: "Scheme",
        keywords: ATTRIBUTES.filter((a) => scopes.includes(a.path[0]!)).map((a) => a.name),
        component: () => <LazyColorSchemePage scopes={scopes} />,
      },
    ],
  };
}

const COLOR_SCHEME_PAGE = editorPage({
  id: "editor.colorScheme",
  title: "Color Scheme",
  order: 23,
  projectScope: false,
  keywords: [
    "colors",
    "syntax highlighting",
    "theme",
    "foreground",
    "background",
    "bold",
    "italic",
    ...SCHEMES.map((s) => s.name),
  ],
  sections: [
    {
      items: [
        {
          t: "custom" as const,
          label: "Scheme",
          keywords: SCHEMES.map((s) => s.name),
          component: () => <LazyColorSchemePage scopes={[]} landing />,
        },
      ],
    },
  ],
});

/** JetBrains layout: scopes and languages live in the settings tree under Color Scheme, one page each. */
export const COLOR_SCHEME_PAGES: PageSpec[] = [
  COLOR_SCHEME_PAGE,
  editorPage({
    id: "editor.colorScheme.general",
    title: "General",
    order: 1,
    projectScope: false,
    keywords: ATTRIBUTES.filter((a) => a.path[0] === "General").map((a) => a.name),
    sections: [colorSchemeSection(["General"])],
  }),
  editorPage({
    id: "editor.colorScheme.language-defaults",
    title: "Language Defaults",
    order: 2,
    projectScope: false,
    keywords: ["semantic highlighting", "rainbow"],
    sections: [
      colorSchemeSection(["Language Defaults"]),
      {
        title: "Language Defaults",
        items: [
          {
            t: "check",
            key: "editor.semanticHighlighting",
            label: "Semantic highlighting",
            hint: "Local variables and parameters get a colour derived from their name (needs a language server).",
          },
          {
            t: "check",
            key: "editor.rainbowBrackets",
            label: "Rainbow brackets",
            hint: "Color (), [] and {} by nesting depth; unmatched brackets use the error color.",
            children: [
              { t: "check", key: "editor.rainbowBracketKinds.round", label: "Round brackets ( )" },
              { t: "check", key: "editor.rainbowBracketKinds.square", label: "Square brackets [ ]" },
              { t: "check", key: "editor.rainbowBracketKinds.curly", label: "Curly braces { }" },
              {
                t: "check",
                key: "editor.rainbowBracketKinds.angle",
                label: "Angle brackets and tags < >",
                hint: "Type arguments and parameters, and HTML, XML and JSX tags, where the syntax tree marks them; comparisons stay uncolored. They count toward the depth of what they enclose: an element's tags take one level, its content the next.",
              },
              { t: "number", key: "editor.rainbowBracketColors", label: "Number of colors", min: 2, max: 5 },
            ],
          },
        ],
      },
    ],
  }),
  editorPage({
    id: "editor.colorScheme.debugger",
    title: "Debugger",
    order: 3,
    projectScope: false,
    keywords: ["breakpoint", "inline values"],
    sections: [colorSchemeSection(["Debugger"])],
  }),
  editorPage({
    id: "editor.colorScheme.console-colors",
    title: "Console Colors",
    order: 4,
    projectScope: false,
    keywords: ["terminal", "ansi", "console", "background"],
    sections: [colorSchemeSection(["Console Colors"])],
  }),
  editorPage({
    id: "editor.colorScheme.git",
    title: "Git",
    order: 5,
    projectScope: false,
    keywords: ["git", "blame", "branch", "inline blame", "project view", "decoration"],
    sections: [colorSchemeSection(["Git"])],
  }),
  ...LANGUAGES.map((language, i) =>
    editorPage({
      id: languagePageId(language),
      title: language,
      order: 6 + i,
      projectScope: false,
      keywords: ATTRIBUTES.filter((a) => a.path[0] === language).map((a) => a.name),
      sections: [colorSchemeSection([language])],
    }),
  ),
];
