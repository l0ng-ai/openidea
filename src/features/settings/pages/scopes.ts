import { APPEARANCE_GROUP } from "./behavior";
import { lazyPage } from "./lazyPage";
import type { PageSpec } from "./spec";

const FileColorsEditor = lazyPage("fileColors", () => import("./ScopesBody").then((m) => m.FileColorsEditor));
const ScopesEditor = lazyPage("scopes", () => import("./ScopesBody").then((m) => m.ScopesEditor));

export const SCOPE_PAGES: PageSpec[] = [
  {
    id: "fileColors",
    title: "File Colors",
    group: APPEARANCE_GROUP,
    order: 1.5,
    projectScope: true,
    defaultScope: "project",
    keywords: ["colour", "color", "tab", "background", "tests", "non-project"],
    sections: [
      {
        options: [
          { kind: "toggle", key: "fileColors.enabled", label: "Enable file colors" },
          { kind: "toggle", key: "fileColors.editorTabs", label: "Use in editor tabs" },
          { kind: "toggle", key: "fileColors.projectView", label: "Use in project view" },
        ],
      },
      {
        options: [
          {
            kind: "custom",
            label: "File Colors",
            keywords: ["Scope", "Color", "Custom", "Hex value"],
            component: FileColorsEditor,
          },
        ],
      },
    ],
  },
  {
    id: "scopes",
    title: "Scopes",
    group: APPEARANCE_GROUP,
    order: 1.6,
    projectScope: true,
    defaultScope: "project",
    keywords: ["scope", "file set", "pattern"],
    sections: [
      {
        options: [{ kind: "custom", label: "Scopes", keywords: ["Name", "Pattern"], component: ScopesEditor }],
      },
    ],
  },
];
