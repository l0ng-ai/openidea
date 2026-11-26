/**
 * Editor › Code Style (General, Other File Types, one page per language from
 * `languages/*.toml`) and Editor › File Encodings. Indentation feeds the
 * editor's effective indent (EditorConfig › detected › language override ›
 * language definition › Other File Types); line separator and encodings feed
 * new-file creation in the backend (`ide-workspace::FileDefaults`). The
 * Scheme (Default / Project) is the scope these pages share; the Formatter tab
 * feeds `platform/formatGuard`.
 */
import { useId, useState } from "react";
import { Button, Checkbox, Input, type SelectOption, T } from "@/ui";
import { commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import { choosePath } from "@/platform/choosePath";
import {
  ENCODING_CHOICES,
  lineCommentDefaults,
  sqlCaseOf,
  type LanguageCodeStyle,
  type SqlWordCase,
} from "@/platform/editorSettings";
import { NATIVE_TO_ASCII_ACTION } from "../../nativeToAscii";
import { FormGroup, NumberInput, Row, Select, Toggle } from "../../components/Form";
import { useSetting } from "../../components/context";
import type { PageSpec } from "../spec";
import {
  CODE_STYLE_SCOPE,
  CodeStyleMain,
  CodeStyleTabs,
  SchemeRow,
  formatterLabels,
  type CodeStyleTab,
} from "./codeStyleScheme";
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

const INDENTS = {
  id: "indents",
  label: "Tabs and Indents",
  keywords: ["Tab size", "Indent", "Use tab character"],
};
const WRAPPING = { id: "wrapping", label: "Wrapping", keywords: ["Hard wrap at"] };
const COMMENTS = {
  id: "comments",
  label: "Comment Code",
  keywords: ["Line comment at first column", "Add a space at line comment start"],
};
const CASE = { id: "case", label: "Case", keywords: ["Keywords", "Identifiers", "To upper", "To lower"] };

const SPACES = { id: "spaces", label: "Spaces", keywords: ["Space", "Around binary operators", "Within braces"] };
const PUNCTUATION = { id: "punctuation", label: "Punctuation", keywords: ["Semicolons", "Quotes"] };

/** The TypeScript server's code style: JavaScript (and JSX) and TypeScript (and TSX). */
const TS_STYLE_LANGUAGES = new Set(["javascript", "typescript"]);

/** tsserver's space options and their defaults (vtsls'). */
const TS_SPACES = [
  { key: "insertSpaceAfterCommaDelimiter", label: "After comma", on: true },
  { key: "insertSpaceAfterSemicolonInForStatements", label: "After semicolon in for statements", on: true },
  { key: "insertSpaceBeforeAndAfterBinaryOperators", label: "Around binary operators", on: true },
  { key: "insertSpaceAfterKeywordsInControlFlowStatements", label: "After control flow keywords", on: true },
  {
    key: "insertSpaceAfterFunctionKeywordForAnonymousFunctions",
    label: "After function keyword in anonymous functions",
    on: true,
  },
  { key: "insertSpaceBeforeFunctionParenthesis", label: "Before function declaration parentheses", on: false },
  { key: "insertSpaceAfterConstructor", label: "After constructor keyword", on: false },
  { key: "insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis", label: "Within parentheses", on: false },
  { key: "insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets", label: "Within brackets", on: false },
  { key: "insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces", label: "Within braces", on: true },
  { key: "insertSpaceAfterOpeningAndBeforeClosingEmptyBraces", label: "Within empty braces", on: true },
  {
    key: "insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces",
    label: "Within template string interpolations",
    on: false,
  },
  { key: "insertSpaceAfterOpeningAndBeforeClosingJsxExpressionBraces", label: "Within JSX expressions", on: false },
  { key: "insertSpaceAfterTypeAssertion", label: "After type assertion", on: false },
];

const SEMICOLONS: SelectOption<NonNullable<LanguageCodeStyle["semicolons"]>>[] = [
  { value: "ignore", label: "Keep as is" },
  { value: "insert", label: "Use semicolons" },
  { value: "remove", label: "Don't use semicolons" },
];

const QUOTES: SelectOption<NonNullable<LanguageCodeStyle["quotes"]>>[] = [
  { value: "auto", label: "As in the file" },
  { value: "single", label: "Single quotes" },
  { value: "double", label: "Double quotes" },
];

const WORD_CASES: SelectOption<SqlWordCase>[] = [
  { value: "upper", label: "To upper" },
  { value: "lower", label: "To lower" },
  { value: "keep", label: "Do not change" },
];

/** Code Style overrides on top of the language definition. */
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
  const tabs: CodeStyleTab[] = [
    {
      ...INDENTS,
      content: (
        <FormGroup>
          <Toggle checked={eff.useTab} onChange={(v) => set({ useTab: v })} label="Use tab character" />
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
        </FormGroup>
      ),
    },
    {
      ...WRAPPING,
      content: (
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
      ),
    },
  ];
  if (lang.lineComment) {
    tabs.push({
      ...COMMENTS,
      content: (
        <>
          <Toggle
            checked={eff.lineCommentAtFirstColumn}
            onChange={(v) => set({ lineCommentAtFirstColumn: v })}
            label="Line comment at first column"
          />
          <Toggle
            checked={eff.lineCommentAddSpace}
            onChange={(v) => set({ lineCommentAddSpace: v })}
            label="Add a space at line comment start"
          />
        </>
      ),
    });
  }
  if (TS_STYLE_LANGUAGES.has(lang.id)) {
    tabs.push(
      {
        ...SPACES,
        content: (
          <>
            {TS_SPACES.map(({ key, label, on }) => (
              <Toggle
                key={key}
                checked={own.spaces?.[key] ?? on}
                onChange={(v) => set({ spaces: { ...own.spaces, [key]: v } })}
                label={label}
              />
            ))}
          </>
        ),
      },
      {
        ...PUNCTUATION,
        content: (
          <FormGroup>
            <Row label="Semicolons">
              <Select
                value={own.semicolons ?? "ignore"}
                options={SEMICOLONS}
                onChange={(semicolons) => set({ semicolons })}
                aria-label="Semicolons"
              />
            </Row>
            <Row label="Quotes" hint="For the strings and imports the TypeScript server adds.">
              <Select
                value={own.quotes ?? "auto"}
                options={QUOTES}
                onChange={(quotes) => set({ quotes })}
                aria-label="Quotes"
              />
            </Row>
          </FormGroup>
        ),
      },
    );
  }
  if (lang.id === "sql") {
    const wordCase = sqlCaseOf(own);
    tabs.push({
      ...CASE,
      content: (
        <FormGroup>
          <Row label="Keywords">
            <Select
              value={wordCase.keywords}
              options={WORD_CASES}
              onChange={(keywordCase) => set({ keywordCase })}
              aria-label="Keywords"
            />
          </Row>
          <Row label="Identifiers" hint="Unquoted table, column and alias names; ClickHouse names keep their case.">
            <Select
              value={wordCase.identifiers}
              options={WORD_CASES}
              onChange={(identifierCase) => set({ identifierCase })}
              aria-label="Identifiers"
            />
          </Row>
        </FormGroup>
      ),
    });
  }
  return (
    <div className={styles.page}>
      <SchemeRow />
      {lang.id === "java" && <JavaFormatter style={own} onChange={set} />}
      <CodeStyleTabs tabs={tabs} />
      {lang.id === "python" && (
        <div className={styles.note}>
          {tx(
            "Ruff formats with the indent, tab character and hard wrap set here, and Black with the hard wrap, when no Ruff or Black configuration of the project or user applies. A file's .editorconfig values come first, as in the editor.",
          )}
        </div>
      )}
      {TS_STYLE_LANGUAGES.has(lang.id) && (
        <div className={styles.note}>
          {tx(
            "The TypeScript server applies Spaces and Punctuation to Reformat Code and to the code it adds: quick fixes, imports, refactorings and organize imports. Files below a Prettier, Biome or oxfmt configuration are formatted by that tool. A .editorconfig's quote_type and ij_* properties come first. TSX files use the TypeScript settings, JSX files the JavaScript ones.",
          )}
        </div>
      )}
      {lang.id === "php" && (
        <section aria-label={tx("Alignment")}>
          <div className={styles.previewTitle}>
            <T>Alignment</T>
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={own.alignKeyValuePairs ?? false}
              onChange={(v) => set({ alignKeyValuePairs: v })}
              label="Align key-value pairs"
            />
          </div>
          <div className={styles.check}>
            <Checkbox
              checked={own.alignConsecutiveAssignments ?? false}
              onChange={(v) => set({ alignConsecutiveAssignments: v })}
              label="Align consecutive assignments"
            />
          </div>
          <div className={styles.note}>
            {tx(
              "Lines up => in multi-line arrays and = in consecutive assignments after the language server or PHP-CS-Fixer formats the file; for a selection, only its lines.",
            )}
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

const JAVA_FORMATTERS: SelectOption<NonNullable<LanguageCodeStyle["formatter"]>>[] = [
  { value: "default", label: "Default" },
  { value: "intellij", label: "IntelliJ IDEA" },
  { value: "custom", label: "Custom Eclipse formatter XML" },
];

function JavaFormatter({
  style,
  onChange,
}: {
  style: LanguageCodeStyle;
  onChange: (patch: Partial<LanguageCodeStyle>) => void;
}) {
  const id = useId();
  const browse = async () => {
    const path = await choosePath({
      directory: false,
      title: tx("Eclipse formatter XML"),
      filters: [{ name: "XML", extensions: ["xml"] }],
    });
    if (typeof path === "string") onChange({ formatterPath: path });
  };
  return (
    <section aria-label={tx("Formatting profile")}>
      <Row
        label="Formatting profile"
        hint="Changes take effect after Apply without restarting the Java language server."
      >
        <Select
          value={style.formatter ?? "default"}
          options={JAVA_FORMATTERS}
          onChange={(formatter) => onChange({ formatter })}
          aria-label="Formatting profile"
        />
      </Row>
      {style.formatter === "custom" && (
        <Row
          label="Eclipse formatter XML"
          htmlFor={id}
          hint="Absolute or project-relative path. To reload an edited XML file, switch to Default, apply, then select Custom again."
        >
          <Input
            id={id}
            value={style.formatterPath ?? ""}
            onChange={(e) => onChange({ formatterPath: e.target.value })}
          />
          <Button size="small" onClick={browse}>
            <T>Browse…</T>
          </Button>
        </Row>
      )}
    </section>
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
        ...[INDENTS, WRAPPING, ...(lang.lineComment ? [COMMENTS] : [])].flatMap(({ label, keywords }) => [
          label,
          ...keywords,
        ]),
        ...(lang.id === "java"
          ? ["Formatting profile", "IntelliJ IDEA", "Custom Eclipse formatter XML", "Eclipse formatter XML"]
          : []),
        ...(lang.id === "php" ? ["Alignment", "Align key-value pairs", "Align consecutive assignments"] : []),
        ...(lang.id === "sql" ? [CASE.label, ...CASE.keywords, "Do not change"] : []),
        ...(TS_STYLE_LANGUAGES.has(lang.id)
          ? [SPACES, PUNCTUATION].flatMap(({ label, keywords }) => [label, ...keywords])
          : []),
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
