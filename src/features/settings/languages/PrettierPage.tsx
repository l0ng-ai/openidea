import { useId } from "react";
import { Input } from "@/ui";
import { Row, Section, Select, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import { DEFAULT_LANGUAGES } from "@/platform/languageSettings";

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
};

export function PrettierPage() {
  const id = useId();
  const [path, setPath] = useSetting<string>("languages.prettier.path");
  const [languages, setLanguages] = useSetting<string[]>("languages.prettier.languages");
  const [prefer, setPrefer] = useSetting<boolean>("languages.prettier.prefer");
  const [save, setSave] = useSetting<boolean>("languages.prettier.runOnSave");
  return (
    <>
      <Section title="Prettier">
        <Row
          label="Prettier path"
          htmlFor={id}
          hint="Auto: nearest project node_modules, managed installation, then PATH. An explicit path overrides auto detection."
        >
          <Input id={id} mono value={path} placeholder="Auto" onChange={(e) => setPath(e.target.value)} />
        </Row>
        <Row label="Formatting provider">
          <Select
            value={prefer ? "prettier" : "auto"}
            onChange={(v) => setPrefer(v === "prettier")}
            aria-label="Formatting provider"
            options={[
              { value: "auto", label: "Automatic (language server first)" },
              { value: "prettier", label: "Prettier" },
            ]}
          />
        </Row>
        <Toggle
          label="Run on save"
          checked={save}
          onChange={setSave}
          hint="Run Prettier on save for enabled languages when it is the selected formatting provider."
        />
      </Section>
      <Section title="Enabled languages">
        {DEFAULT_LANGUAGES.prettier.languages.map((language) => (
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
