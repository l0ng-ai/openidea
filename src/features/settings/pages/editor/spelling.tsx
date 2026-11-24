/**
 * Editor › Natural Languages (the bundled language) and its Spelling page:
 * the Typo inspection's accepted words (project- and application-level
 * dictionaries, also filled by the "Save to dictionary" quick fix) and custom
 * dictionary files.
 */
import { useId, useState } from "react";
import { useSettingsDialog } from "../../model/staging";
import { useSetting } from "../../components/context";
import { GlobListEditor, Row, SearchLabel, Section } from "../../components/Form";
import { useProject } from "@/platform/project";
import { Select, T, Tabs } from "@/ui";
import type { SelectOption } from "@/ui";
import type { PageSpec } from "../spec";
import formStyles from "../../components/Form.module.css";
import styles from "./Spelling.module.css";

function NaturalLanguagesPage() {
  return (
    <Section title="Languages">
      <Row
        label="English (USA, UK)"
        hint="Bundled Hunspell dictionaries (SCOWL en_US and en_GB) and common programming terms."
      >
        <span className={formStyles.hint}>
          <T>Used by Proofreading › Typo</T>
        </span>
      </Row>
    </Section>
  );
}

const words = (list: readonly string[]) => [...new Set(list.map((w) => w.trim()).filter(Boolean))];

const wordDictionaries = [
  { id: "project", label: "Project dictionary", hint: "Stored with the project." },
  { id: "application", label: "Application dictionary", hint: "Accepted in every project." },
];

function AcceptedWords() {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const [projectWords, setProjectWords] = useSetting<string[]>("spelling.projectWords", "project");
  const [ideWords, setIdeWords] = useSetting<string[]>("spelling.ideWords", "global");
  const [scope, setScope] = useState("project");
  const id = useId();
  const showProject = hasProject && !newProjects;
  const scopes = showProject ? wordDictionaries : wordDictionaries.slice(1);
  const activeScope = showProject ? scope : "application";

  return (
    <>
      {showProject && (
        <Tabs
          items={wordDictionaries}
          activeId={activeScope}
          onSelect={setScope}
          variant="compact"
          layout="wrap"
          panelIdPrefix={id}
          aria-label="Accepted words"
        />
      )}
      {scopes.map(({ id: scopeId, label, hint }) => {
        const isProject = scopeId === "project";
        const active = activeScope === scopeId;
        const value = isProject ? projectWords : ideWords;
        const setValue = isProject ? setProjectWords : setIdeWords;
        return (
          <div
            key={scopeId}
            id={`${id}-panel-${scopeId}`}
            role={showProject ? "tabpanel" : undefined}
            aria-labelledby={showProject ? `${id}-tab-${scopeId}` : undefined}
            hidden={!active}
            className={styles.wordPanel}
          >
            {active && (
              <>
                {!showProject && <SearchLabel text={label} />}
                <GlobListEditor
                  className={styles.list}
                  aria-label={label}
                  value={value ?? []}
                  onChange={(v) => setValue(words(v))}
                  placeholder="word"
                  emptyText="No words"
                  itemLabel="Word"
                  mono={false}
                />
                <p className={styles.note}>
                  <T>{hint}</T>
                </p>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

function SpellingPage() {
  const [dictionaries, setDictionaries] = useSetting<string[]>("spelling.customDictionaries", "global");
  const [defaultDictionary, setDefaultDictionary] = useSetting<string>("spelling.defaultDictionary", "global");
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const hasProject = useProject((s) => !!s.project) && !newProjects;
  const fallback = hasProject ? "project" : "application";
  const options: SelectOption<string>[] = [
    ...(hasProject ? [{ value: "project", label: "Project dictionary" }] : []),
    { value: "application", label: "Application dictionary" },
    ...words(dictionaries ?? [])
      .filter((d) => d !== "project" && d !== "application")
      .map((d) => ({ value: d, label: d, verbatim: true })),
  ];
  return (
    <div className={styles.spelling}>
      <Section stackFields>
        <Row label="Default dictionary" hint="The dictionary the editor's Save '…' to dictionary quick fix writes to.">
          <Select
            value={options.some((option) => option.value === defaultDictionary) ? defaultDictionary : fallback}
            options={options}
            onChange={(v) => setDefaultDictionary(v)}
            aria-label="Default dictionary"
          />
        </Row>
      </Section>
      <Section title="Custom dictionaries">
        <Row
          label="Dictionary files"
          stacked
          hint="Plain-text word lists (one word per line) or Hunspell .dic files; a .dic with its .aff beside it also accepts the inflected forms and compounds its rules allow. Relative paths resolve against the project root, ~/ against the home folder."
        >
          <GlobListEditor
            className={styles.list}
            aria-label="Custom dictionaries"
            value={dictionaries ?? []}
            onChange={(v) => setDictionaries(words(v))}
            placeholder="~/dictionaries/team.dic"
            emptyText="No custom dictionaries"
            itemLabel="Dictionary path"
          />
        </Row>
      </Section>
      <Section title="Accepted words">
        <AcceptedWords />
      </Section>
    </div>
  );
}

export const NATURAL_LANGUAGES_PAGE: PageSpec = {
  id: "editor.naturalLanguages",
  title: "Natural Languages",
  group: "Editor",
  order: 26,
  keywords: ["natural languages", "English", "grammar", "proofreading"],
  component: NaturalLanguagesPage,
};

export const SPELLING_PAGE: PageSpec = {
  id: "editor.naturalLanguages.spelling",
  title: "Spelling",
  group: "Editor",
  order: 1,
  keywords: [
    "spelling",
    "typo",
    "dictionary",
    "accepted words",
    "project dictionary",
    "application dictionary",
    "custom dictionaries",
    "hunspell",
  ],
  component: SpellingPage,
};
