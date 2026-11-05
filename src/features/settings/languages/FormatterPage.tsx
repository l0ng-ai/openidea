import { useId } from "react";
import type { ExternalFormatter } from "@/bindings";
import { IconButton, Input } from "@/ui";
import { Row, Section, Select, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import { DEFAULT_LANGUAGES } from "@/platform/languageSettings";
import { choosePath } from "./api";
import styles from "./Sdk.module.css";

const names: Record<string, string> = {
  markdown: "Markdown",
  yaml: "YAML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  graphql: "GraphQL",
  javascript: "JavaScript",
  javascriptreact: "JavaScript JSX",
  typescript: "TypeScript",
  typescriptreact: "TypeScript JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  vue: "Vue",
  python: "Python",
};

interface FormatterPageProps {
  tool: ExternalFormatter;
  name: string;
  pathLabel: string;
  pathHint?: string;
  configurationDirectory?: boolean;
  providerHint?: string;
  saveHint: string;
}

function FormatterPage({
  tool,
  name,
  pathLabel,
  pathHint = "Auto: nearest project node_modules, managed installation, then PATH. An explicit path overrides auto detection.",
  configurationDirectory = false,
  providerHint,
  saveHint,
}: FormatterPageProps) {
  const id = useId();
  const [path, setPath] = useSetting<string>(`languages.${tool}.path`);
  const [languages, setLanguages] = useSetting<string[]>(`languages.${tool}.languages`);
  const [prefer, setPrefer] = useSetting<boolean>(`languages.${tool}.prefer`);
  const [save, setSave] = useSetting<boolean>(`languages.${tool}.runOnSave`);
  return (
    <>
      <Section title={name}>
        <Row label={pathLabel} htmlFor={id} hint={pathHint}>
          <Input id={id} mono value={path} placeholder="Auto" onChange={(e) => setPath(e.target.value)} />
        </Row>
        {configurationDirectory && <ConfigurationDirectory settingKey={`languages.${tool}.configurationDirectory`} />}
        <Row label="Formatting provider" hint={providerHint}>
          <Select
            value={prefer ? tool : "auto"}
            onChange={(v) => setPrefer(v === tool)}
            aria-label="Formatting provider"
            options={[
              { value: "auto", label: "Automatic (language server first)" },
              { value: tool, label: name },
            ]}
          />
        </Row>
        <Toggle label="Run on save" checked={save} onChange={setSave} hint={saveHint} />
      </Section>
      <Section title="Enabled languages">
        {DEFAULT_LANGUAGES[tool].languages.map((language) => (
          <Toggle
            key={language}
            label={names[language]!}
            checked={languages.includes(language)}
            onChange={(checked) =>
              setLanguages(checked ? [...languages, language] : languages.filter((l) => l !== language))
            }
          />
        ))}
      </Section>
    </>
  );
}

function ConfigurationDirectory({ settingKey }: { settingKey: string }) {
  const id = useId();
  const [path, setPath] = useSetting<string>(settingKey);
  return (
    <Row
      label="Configuration directory"
      htmlFor={id}
      hint="Empty uses the nearest project pyproject.toml ([tool.ruff]), ruff.toml, or .ruff.toml. A configured directory must contain one of them."
    >
      <span className={styles.pathRow}>
        <Input
          id={id}
          mono
          className={styles.pathInput}
          value={path}
          placeholder="Project configuration"
          onChange={(e) => setPath(e.target.value)}
        />
        <IconButton
          icon="folder-open"
          size="small"
          title="Browse…"
          aria-label="Select Ruff Configuration Directory"
          onClick={async () => {
            const picked = await choosePath({
              directory: true,
              title: "Select Ruff Configuration Directory",
              defaultPath: path || undefined,
            });
            if (picked) setPath(picked);
          }}
        />
      </span>
    </Row>
  );
}

export function PrettierPage() {
  return (
    <FormatterPage
      tool="prettier"
      name="Prettier"
      pathLabel="Prettier path"
      saveHint="Run Prettier on save for enabled languages when it is the selected formatting provider."
    />
  );
}

export function OxfmtPage() {
  return (
    <FormatterPage
      tool="oxfmt"
      name="oxfmt"
      pathLabel="oxfmt path"
      providerHint="oxfmt formats an enabled language instead of Prettier below an oxfmt configuration file (.oxfmtrc.json, oxfmt.config.ts) or when it is the selected provider."
      saveHint="Run oxfmt on save for enabled languages when it is the selected formatting provider."
    />
  );
}

export function RuffPage() {
  return (
    <FormatterPage
      tool="ruff"
      name="Ruff"
      pathLabel="Ruff path"
      pathHint="Auto: managed installation, then PATH. An explicit path overrides auto detection."
      configurationDirectory
      providerHint="Ruff reads the nearest pyproject.toml ([tool.ruff]), ruff.toml, or .ruff.toml. Use it before the language server when preferred."
      saveHint="Run Ruff on save for enabled languages when it is the selected formatting provider."
    />
  );
}
