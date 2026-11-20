/** Built-in settings pages (IDEA layout: Appearance & Behavior, Keymap, Editor). */
import { useId, useState } from "react";
import { Tabs } from "@/ui";
import { GlobListEditor, Row } from "../components/Form";
import { useSearchQuery, useSetting } from "../components/context";
import { keymapSearchLabels } from "../keymap/model";
import { labelMatches, queryTerms } from "../model/pages";
import { lazyPage } from "./lazyPage";
import { OptionsPage } from "./OptionsPage";
import { specLabels, type PageSpec, type SectionSpec } from "./spec";
import styles from "./FileTypes.module.css";
export const EDITOR_GROUP = "Editor";

const KeymapPage = lazyPage("keymap", () => import("../keymap/KeymapPage").then((m) => m.KeymapPage));
const RecognizedFileTypes = lazyPage("editor.files", () => import("./FileTypes").then((m) => m.RecognizedFileTypes));
const AssociatedApplicationsRow = lazyPage("editor.files", () =>
  import("./FileTypes").then((m) => m.AssociatedApplicationsRow),
);

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

const FILE_TYPE_TABS: { id: string; label: string; sections: SectionSpec[] }[] = [
  {
    id: "recognized",
    label: "Recognized File Types",
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
        title: "Files opened in associated applications",
        options: [
          {
            kind: "custom",
            label: "File name patterns",
            keywords: ["associated application", "external", "default application", "open with"],
            component: AssociatedApplicationsRow,
          },
        ],
      },
    ],
  },
  {
    id: "ignored",
    label: "Ignored Files and Folders",
    sections: [
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

const FILE_TYPES: PageSpec = {
  id: "editor.files",
  title: "File Types",
  group: EDITOR_GROUP,
  order: 29,
  projectScope: true,
  keywords: ["ignore", "ignored", "excluded", "glob", "exclude patterns", "associate", "association", "extension"],
  sections: FILE_TYPE_TABS.flatMap((tab) => tab.sections),
  component: FileTypesPage,
};

function FileTypesPage() {
  const prefix = useId();
  const query = useSearchQuery();
  const [selection, select] = useState({ id: "recognized", query: "" });
  let active = selection.id;
  if (query !== selection.query) {
    const terms = queryTerms(query);
    let best = 0;
    for (const tab of FILE_TYPE_TABS) {
      const labels = specLabels({ ...FILE_TYPES, keywords: [], sections: tab.sections });
      const score = terms.filter((term) => labels.some((label) => labelMatches(label, term))).length;
      if (score > best) {
        best = score;
        active = tab.id;
      }
    }
  }
  return (
    <>
      <Tabs
        aria-label="File Types"
        variant="compact"
        layout="wrap"
        className={styles.tabs}
        items={FILE_TYPE_TABS.map(({ id, label }) => ({ id, label }))}
        activeId={active}
        panelIdPrefix={prefix}
        onSelect={(id) => select({ id, query })}
      />
      {FILE_TYPE_TABS.map(({ id, sections }) => (
        <div
          key={id}
          role="tabpanel"
          id={`${prefix}-panel-${id}`}
          aria-labelledby={`${prefix}-tab-${id}`}
          hidden={id !== active}
        >
          <OptionsPage
            spec={{
              ...FILE_TYPES,
              sections: sections.map((section, i) => (i === 0 ? { ...section, title: undefined } : section)),
            }}
          />
        </div>
      ))}
    </>
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
  FILE_TYPES,
];
