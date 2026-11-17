/**
 * Code Style › Scheme (IDEA's Default = IDE-level, Project = stored in the
 * project) and the Formatter tab. The scheme is the scope shared by Code Style
 * and its language pages (`scopeGroup`); "Copy to Project" / "Copy to IDE"
 * stage every Code Style value in the other scope.
 */
import { useState } from "react";
import clsx from "clsx";
import { Button, T, type SelectOption } from "@/ui";
import { useProject } from "@/platform/project";
import { GlobListEditor, Row, Select } from "../../components/Form";
import { usePageContext, useSetting } from "../../components/context";
import { setPageScope, stage, stagedValue, useSettingsDialog, type Scope } from "../../model/staging";
import { EditorSections, sectionLabels, type EditorSection } from "./kit";
import { PluginFormattersSection } from "./pluginFormatters";
import styles from "./CodeStyle.module.css";
import { tx } from "@/platform/i18n";

export const CODE_STYLE_SCOPE = "editor.codeStyle";

/** What a Code Style scheme holds. */
export const CODE_STYLE_KEYS = [
  "editor.tabSize",
  "editor.insertSpaces",
  "editor.codeStyle.lineSeparator",
  "editor.codeStyle.hardWrapAt",
  "editor.codeStyle.visualGuides",
  "editor.codeStyle.detectIndents",
  "editor.codeStyle.editorconfig",
  "editor.codeStyle.languages",
  "editor.codeStyle.doNotFormat",
  "editor.codeStyle.formatterTagsEnabled",
  "editor.codeStyle.formatterOffTag",
  "editor.codeStyle.formatterOnTag",
  "editor.codeStyle.formatterTagsRegexp",
  "languages.pluginFormatters",
] as const;

/** Stages the `from` scheme's values in the `to` scheme (`page` owns the staged edits). */
export function copyScheme(page: string, from: Scope, to: Scope) {
  const s = useSettingsDialog.getState();
  for (const key of CODE_STYLE_KEYS) {
    const value = stagedValue(s, from, key);
    if (value !== undefined) stage(page, to, key, value);
  }
}

export function SchemeRow() {
  const { pageId, scope } = usePageContext();
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const canProject = hasProject && !newProjects;
  const options: SelectOption<Scope>[] = [
    { value: "global", label: "Default (IDE)" },
    ...(canProject ? [{ value: "project" as const, label: "Project" }] : []),
  ];
  const other: Scope = scope === "global" ? "project" : "global";
  return (
    <Row
      label="Scheme"
      hint={
        scope === "project" ? "Stored in the project." : "Stored in the IDE; used by projects without their own scheme."
      }
    >
      <span className={styles.scheme}>
        <Select<Scope>
          value={scope}
          options={options}
          onChange={(v) => setPageScope(CODE_STYLE_SCOPE, v)}
          aria-label="Scheme"
        />
        {canProject && (
          <Button
            size="small"
            onClick={() => {
              copyScheme(pageId, scope, other);
              setPageScope(CODE_STYLE_SCOPE, other);
            }}
          >
            <T>{scope === "global" ? "Copy to Project" : "Copy to IDE"}</T>
          </Button>
        )}
      </span>
    </Row>
  );
}

function DoNotFormatRow() {
  const [globs, setGlobs] = useSetting<string[]>("editor.codeStyle.doNotFormat");
  return (
    <Row label="Do not format" stacked hint="File name patterns and folders (glob), e.g. *.min.js, generated/**.">
      <GlobListEditor value={globs ?? []} onChange={setGlobs} placeholder="*.min.js" aria-label="Do not format" />
    </Row>
  );
}

export const FORMATTER_SECTIONS: EditorSection[] = [
  {
    items: [
      { t: "custom", label: "Do not format", keywords: ["glob", "exclude from formatting"], component: DoNotFormatRow },
      {
        t: "check",
        key: "editor.codeStyle.formatterTagsEnabled",
        label: "Turn formatter on/off with markers in code comments",
        children: [
          { t: "text", key: "editor.codeStyle.formatterOffTag", label: "Off", placeholder: "@formatter:off" },
          { t: "text", key: "editor.codeStyle.formatterOnTag", label: "On", placeholder: "@formatter:on" },
          {
            t: "check",
            key: "editor.codeStyle.formatterTagsRegexp",
            label: "Enable regular expressions in formatter markers",
          },
        ],
      },
    ],
  },
];

type Tab = "general" | "formatter";

/** Code Style: Scheme, then the General / Formatter tabs. */
export function CodeStyleMain({ general }: { general: EditorSection[] }) {
  const [tab, setTab] = useState<Tab>("general");
  const tabs: Array<[Tab, string]> = [
    ["general", "General"],
    ["formatter", "Formatter"],
  ];
  return (
    <div className={styles.page}>
      <SchemeRow />
      <div className={styles.tabs} role="tablist" aria-label={tx("Code Style")}>
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={clsx(styles.tab, tab === id && styles.tabOn)}
            onClick={() => setTab(id)}
          >
            <T>{label}</T>
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <EditorSections sections={tab === "general" ? general : FORMATTER_SECTIONS} />
        {tab === "formatter" && <PluginFormattersSection />}
      </div>
    </div>
  );
}

export const formatterLabels = () => ["Scheme", "Formatter", ...sectionLabels(FORMATTER_SECTIONS), "Plugin Formatters"];
