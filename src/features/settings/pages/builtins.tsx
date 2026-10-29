/** Built-in settings pages (IDEA layout: Appearance & Behavior, Keymap, Editor). */
import { GlobListEditor, Row } from "../components/Form";
import { useSetting } from "../components/context";
import { KeymapPage, keymapSearchLabels } from "../keymap/KeymapPage";
import { RecognizedFileTypes } from "./FileTypes";
import type { PageSpec } from "./spec";
export const EDITOR_GROUP = "Editor";

function ExcludeRow() {
  const [exclude, setExclude] = useSetting<string[]>("files.exclude");
  return (
    <Row
      label="Exclude patterns"
      stacked
      hint="Glob patterns (e.g. **/dist, *.log) hidden from the project tree and skipped by search and indexing."
    >
      <GlobListEditor value={exclude} onChange={setExclude} aria-label="Exclude patterns" />
    </Row>
  );
}

function IgnoredNamesRow() {
  const [names, setNames] = useSetting<string[]>("files.ignoredNames");
  return (
    <Row
      label="Ignore files and folders"
      stacked
      hint="Names (e.g. .DS_Store, *.pyc) hidden from the project tree, navigation bar, search, indexing and Git changes."
    >
      <GlobListEditor value={names} onChange={setNames} placeholder="*.ext" aria-label="Ignored names" />
    </Row>
  );
}

export const BUILTIN_PAGES: PageSpec[] = [
  {
    id: "keymap",
    title: "Keymap",
    order: 10,
    keywords: ["shortcut", "keyboard", "hotkey", "binding", "preset", "vs code", "intellij"],
    component: KeymapPage,
    dynamicLabels: keymapSearchLabels,
  },
  {
    id: "editor.files",
    title: "File Types",
    group: EDITOR_GROUP,
    order: 29,
    projectScope: true,
    keywords: ["ignore", "ignored", "excluded", "glob", "exclude patterns", "associate", "association", "extension"],
    sections: [
      {
        title: "Recognized File Types",
        options: [
          {
            kind: "custom",
            label: "File name patterns",
            keywords: ["Hashbang patterns", "file type", "language"],
            component: RecognizedFileTypes,
          },
        ],
      },
      {
        title: "Ignored Files and Folders",
        options: [
          { kind: "custom", label: "Ignore files and folders", component: IgnoredNamesRow },
          { kind: "custom", label: "Exclude patterns", component: ExcludeRow },
        ],
      },
    ],
  },
];
