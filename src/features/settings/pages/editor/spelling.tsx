/**
 * Editor › Natural Languages (the bundled language) and its Spelling page:
 * the Typo inspection's accepted words (project- and application-level
 * dictionaries, also filled by the "Save to dictionary" quick fix) and custom
 * dictionary files.
 */
import { useSettingsDialog } from "../../model/staging";
import { useSetting } from "../../components/context";
import { GlobListEditor, Row, Section } from "../../components/Form";
import { useProject } from "@/platform/project";
import { T } from "@/ui";
import type { PageSpec } from "../spec";
import styles from "../../components/Form.module.css";

function NaturalLanguagesPage() {
  return (
    <Section title="Languages">
      <Row
        label="English (USA, UK)"
        hint="Bundled Hunspell dictionaries (SCOWL en_US and en_GB) and common programming terms."
      >
        <span className={styles.hint}>
          <T>Used by Proofreading › Typo</T>
        </span>
      </Row>
    </Section>
  );
}

const words = (list: readonly string[]) => [...new Set(list.map((w) => w.trim()).filter(Boolean))];

function SpellingPage() {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const [projectWords, setProjectWords] = useSetting<string[]>("spelling.projectWords", "project");
  const [ideWords, setIdeWords] = useSetting<string[]>("spelling.ideWords", "global");
  const [dictionaries, setDictionaries] = useSetting<string[]>("spelling.customDictionaries", "global");
  return (
    <>
      <Section title="Accepted words">
        {hasProject && !newProjects && (
          <Row label="Project dictionary" stacked hint="Stored with the project.">
            <GlobListEditor
              aria-label="Project dictionary"
              value={projectWords ?? []}
              onChange={(v) => setProjectWords(words(v))}
              placeholder="word"
              emptyText="No words"
              itemLabel="Word"
            />
          </Row>
        )}
        <Row label="Application dictionary" stacked hint="Accepted in every project.">
          <GlobListEditor
            aria-label="Application dictionary"
            value={ideWords ?? []}
            onChange={(v) => setIdeWords(words(v))}
            placeholder="word"
            emptyText="No words"
            itemLabel="Word"
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
            aria-label="Custom dictionaries"
            value={dictionaries ?? []}
            onChange={(v) => setDictionaries(words(v))}
            placeholder="~/dictionaries/team.dic"
            emptyText="No custom dictionaries"
            itemLabel="Dictionary path"
          />
        </Row>
      </Section>
    </>
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
