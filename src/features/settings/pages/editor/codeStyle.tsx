/**
 * Editor › Code Style (General, Other File Types, one page per language from
 * `languages/*.toml`) and Editor › File Encodings. Indentation feeds the
 * editor's effective indent (EditorConfig › detected › language override ›
 * language definition › Other File Types); line separator and encodings feed
 * new-file creation in the backend (`ide-workspace::FileDefaults`). The
 * Scheme (Default / Project) is the scope these pages share; the Formatter tab
 * feeds `platform/formatGuard`.
 */
import { NATIVE_TO_ASCII_ACTION } from "../../nativeToAscii";
import { useId, useState } from "react";
import { Button, Checkbox, Input, type SelectOption, T } from "@/ui";
import { commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import { ENCODING_CHOICES, lineCommentDefaults, type LanguageCodeStyle } from "@/platform/editorSettings";
import { NumberInput, Row } from "../../components/Form";
import { useSetting } from "../../components/context";
import type { PageSpec } from "../spec";
import { CODE_STYLE_SCOPE, CodeStyleMain, SchemeRow, formatterLabels } from "./codeStyleScheme";
import { editorPage, sectionLabels, type EditorSection } from "./kit";
import styles from "./Editor.module.css";
import { tx } from "@/platform/i18n";

function VisualGuidesRow() {
  const [guides, setGuides] = useSetting<number[]>("editor.codeStyle.visualGuides");
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const parse = (t: string) =>
    t
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number);
  const text = draft ?? guides.join(", ");
  const invalid = draft !== null && parse(draft).some((n) => !Number.isInteger(n) || n < 1 || n > 999);
  return (
    <Row label="Visual guides" htmlFor={id} hint="Comma-separated column numbers, e.g. 80, 100.">
      <Input
        id={id}
        className={styles.guides}
        value={text}
        invalid={invalid}
        placeholder="Optional"
        onChange={(e) => {
          setDraft(e.target.value);
          const nums = parse(e.target.value);
          if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 999)) setGuides(nums);
        }}
        onBlur={() => setDraft(null)}
      />
      <span className={styles.suffix}>
        <T>columns</T>
      </span>
    </Row>
  );
}

const LINE_SEPARATORS: SelectOption[] = [
  { value: "system", label: "System-Dependent" },
  { value: "lf", label: "Unix and macOS (\\n)" },
  { value: "crlf", label: "Windows (\\r\\n)" },
  { value: "cr", label: "Classic Mac OS (\\r)" },
];

const GENERAL_SECTIONS: EditorSection[] = [
  {
    items: [
      {
        t: "select",
        key: "editor.codeStyle.lineSeparator",
        label: "Line separator",
        options: LINE_SEPARATORS,
        hint: "Used for new files.",
      },
      { t: "number", key: "editor.codeStyle.hardWrapAt", label: "Hard wrap at", min: 1, max: 999, unit: "columns" },
      { t: "custom", label: "Visual guides", component: VisualGuidesRow },
    ],
  },
  {
    title: "Indents Detection",
    items: [
      {
        t: "check",
        key: "editor.codeStyle.detectIndents",
        label: "Detect and use existing file indents for editing",
      },
    ],
  },
  {
    title: "EditorConfig",
    items: [
      {
        t: "check",
        key: "editor.codeStyle.editorconfig",
        label: "Enable EditorConfig support",
        hint: ".editorconfig files override indentation, line separators, encodings and save options.",
      },
    ],
  },
];

/** Shared by Code Style and its sub-pages: the scheme is one scope. */
const SCHEME_SCOPE = { projectScope: true, scopeGroup: CODE_STYLE_SCOPE, ownScopeSwitch: true } as const;

const CODE_STYLE: PageSpec = {
  id: "editor.codeStyle",
  title: "Code Style",
  group: "Editor",
  order: 24,
  ...SCHEME_SCOPE,
  keywords: ["indent", "indentation", "tabs", "line separator", "editorconfig", "right margin", "scheme", "formatter"],
  component: () => <CodeStyleMain general={GENERAL_SECTIONS} />,
  dynamicLabels: () => [...sectionLabels(GENERAL_SECTIONS), ...formatterLabels()],
};

const OTHER = {
  ...editorPage({
    id: "editor.codeStyle.other",
    title: "Other File Types",
    order: 1000,
    keywords: ["tab size", "indent"],
    sections: [
      { items: [{ t: "custom", label: "Scheme", component: SchemeRow }] },
      {
        title: "Tabs and Indents",
        items: [
          { t: "check", key: "editor.insertSpaces", label: "Use tab character", invert: true },
          { t: "number", key: "editor.tabSize", label: "Tab size", min: 1, max: 16 },
        ],
      },
    ],
  }),
  ...SCHEME_SCOPE,
};

/** Tabs and Indents of one language: overrides on top of the language definition. */
function LanguageStyle({ lang }: { lang: LanguageInfo }) {
  const [all, setAll] = useSetting<Record<string, LanguageCodeStyle>>("editor.codeStyle.languages");
  const [tabSize] = useSetting<number>("editor.tabSize");
  const [spaces] = useSetting<boolean>("editor.insertSpaces");
  const [wrap] = useSetting<number>("editor.codeStyle.hardWrapAt");
  const own = all?.[lang.id] ?? {};
  const base = { useTab: !(lang.indent?.insertSpaces ?? spaces), tabSize: lang.indent?.tabSize ?? tabSize };
  const eff = {
    useTab: own.useTab ?? base.useTab,
    tabSize: own.tabSize ?? base.tabSize,
    indent: own.indent ?? own.tabSize ?? base.tabSize,
    hardWrapAt: own.hardWrapAt ?? wrap,
    lineCommentAtFirstColumn: own.lineCommentAtFirstColumn ?? lineCommentDefaults(lang.id).atFirstColumn,
    lineCommentAddSpace: own.lineCommentAddSpace ?? lineCommentDefaults(lang.id).addSpace,
  };
  const set = (patch: Partial<LanguageCodeStyle>) => {
    const next = { ...own, ...patch };
    setAll({ ...(all ?? {}), [lang.id]: next });
  };
  const reset = () => {
    const next = { ...(all ?? {}) };
    delete next[lang.id];
    setAll(next);
  };
  return (
    <div className={styles.page}>
      <SchemeRow />
      <section aria-label={tx("Tabs and Indents")}>
        <div className={styles.previewTitle}>
          <T>Tabs and Indents</T>
        </div>
        <div className={styles.check}>
          <Checkbox checked={eff.useTab} onChange={(v) => set({ useTab: v })} label="Use tab character" />
        </div>
        <Row label="Tab size">
          <NumberInput
            value={eff.tabSize}
            onChange={(n) => set({ tabSize: n })}
            min={1}
            max={16}
            integer
            aria-label="Tab size"
          />
        </Row>
        <Row label="Indent">
          <NumberInput
            value={eff.indent}
            onChange={(n) => set({ indent: n })}
            min={1}
            max={16}
            integer
            aria-label="Indent"
          />
        </Row>
      </section>
      <section aria-label={tx("Wrapping")}>
        <div className={styles.previewTitle}>
          <T>Wrapping</T>
        </div>
        <Row label="Hard wrap at" hint="Shown as the right margin guide in the editor.">
          <NumberInput
            value={eff.hardWrapAt}
            onChange={(n) => set({ hardWrapAt: n })}
            min={1}
            max={999}
            integer
            aria-label="Hard wrap at"
            unit="columns"
          />
        </Row>
      </section>
      {lang.lineComment && (
        <section aria-label={tx("Comment Code")}>
          <div className={styles.previewTitle}>
            <T>Comment Code</T>
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={eff.lineCommentAtFirstColumn}
              onChange={(v) => set({ lineCommentAtFirstColumn: v })}
              label="Line comment at first column"
            />
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={eff.lineCommentAddSpace}
              onChange={(v) => set({ lineCommentAddSpace: v })}
              label="Add a space at line comment start"
            />
          </div>
        </section>
      )}
      <div className={styles.schemeRow}>
        <Button size="small" disabled={!all?.[lang.id]} onClick={reset}>
          <T>Reset to Language Defaults</T>
        </Button>
        <span className={styles.inherited}>
          {base.useTab
            ? tx`Defaults from the ${lang.name} language definition: tab.`
            : tx`Defaults from the ${lang.name} language definition: ${base.tabSize} spaces.`}
        </span>
      </div>
    </div>
  );
}

const SKIP = new Set(["plaintext", "log", "diff", "ignore", "gitattributes"]);

/** One Code Style page per language (registered once the language list is known). */
export async function codeStyleLanguagePages(): Promise<PageSpec[]> {
  if (!isTauri()) return [];
  const langs = await commands.languages();
  return langs
    .filter((l) => !SKIP.has(l.id))
    .map((lang) => ({
      id: `editor.codeStyle.${lang.id}`,
      title: lang.name,
      group: "Editor",
      order: 100,
      ...SCHEME_SCOPE,
      keywords: [
        "Scheme",
        "Tabs and Indents",
        "Tab size",
        "Indent",
        "Use tab character",
        "Hard wrap at",
        "Comment Code",
        "Line comment at first column",
      ],
      component: () => <LanguageStyle lang={lang} />,
    }));
}

const ENCODINGS: SelectOption[] = ENCODING_CHOICES.map(([value, label]) => ({ value, label }));

const ENCODINGS_PAGE = editorPage({
  id: "editor.fileEncodings",
  title: "File Encodings",
  order: 27,
  projectScope: true,
  keywords: ["encoding", "charset", "utf-8", "bom", "native-to-ascii", "properties"],
  sections: [
    {
      items: [
        {
          t: "select",
          key: "editor.encodings.global",
          label: "Global Encoding",
          options: ENCODINGS,
          hint: "Decodes files outside the project that are not valid UTF-8.",
        },
        {
          t: "select",
          key: "editor.encodings.project",
          label: "Project Encoding",
          options: ENCODINGS,
          hint: "Encoding of new files; decodes project files that are not valid UTF-8 and have no BOM.",
        },
      ],
    },
    {
      title: "Properties Files (*.properties)",
      items: [
        {
          t: "select",
          key: "editor.encodings.properties",
          label: "Default encoding for properties files",
          options: ENCODINGS,
        },
        {
          t: "check",
          key: "editor.encodings.nativeToAscii",
          action: NATIVE_TO_ASCII_ACTION,
          label: "Transparent native-to-ascii conversion",
        },
      ],
    },
    {
      items: [
        {
          t: "select",
          key: "editor.encodings.utf8Bom",
          label: "Create UTF-8 files",
          options: [
            { value: "never", label: "with NO BOM" },
            { value: "always", label: "with BOM" },
            { value: "windows", label: "with BOM under Windows, with no BOM otherwise" },
          ],
        },
        {
          t: "note",
          text: "A charset in .editorconfig takes precedence. Change one file's encoding from the status bar.",
        },
      ],
    },
  ],
});

export const CODE_STYLE_PAGES = [CODE_STYLE, OTHER, ENCODINGS_PAGE];
