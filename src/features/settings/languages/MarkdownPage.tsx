import { useId } from "react";
import { NumberInput, Row, Section, Select, SettingToggle } from "../components/Form";
import { useSetting } from "../components/context";

/** Languages & Frameworks › Markdown, after IDEA's: application-level, preview font size follows the editor font until set. */
export function MarkdownPage() {
  const id = useId();
  const [size, setSize] = useSetting<number | null>("languages.markdown.previewFontSize");
  const [editorSize] = useSetting<number>("editor.fontSize");
  const [runCommands] = useSetting<boolean>("languages.markdown.runCommands");
  const [directory, setDirectory] = useSetting<"project" | "file" | null>("languages.markdown.commandDirectory");
  return (
    <>
      <Section title="Preview">
        <Row
          label="Preview font size"
          htmlFor={id}
          hint="Also used by Markdown cells in Jupyter notebooks. Defaults to the editor font size, independent of the UI font size."
        >
          <NumberInput
            id={id}
            value={size ?? editorSize}
            onChange={setSize}
            min={8}
            max={72}
            integer
            unit="px"
            aria-label="Preview font size"
          />
        </Row>
      </Section>
      <Section title="Commands">
        <SettingToggle
          k="languages.markdown.runCommands"
          label="Detect commands that can be run right from Markdown files"
        />
        <Row label="Run commands from" disabled={!runCommands}>
          <Select<"project" | "file">
            value={directory ?? ("" as "project")}
            options={DIRECTORY_OPTIONS}
            onChange={setDirectory}
            disabled={!runCommands}
            aria-label="Run commands from"
          />
        </Row>
      </Section>
    </>
  );
}

const DIRECTORY_OPTIONS = [
  { value: "project", label: "Project directory" },
  { value: "file", label: "Markdown file parent directory" },
] as const;
