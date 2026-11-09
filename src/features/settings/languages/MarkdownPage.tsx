import { useId } from "react";
import { NumberInput, Row, Section } from "../components/Form";
import { useSetting } from "../components/context";

/** Languages & Frameworks › Markdown, after IDEA's: application-level, preview font size follows the editor font until set. */
export function MarkdownPage() {
  const id = useId();
  const [size, setSize] = useSetting<number | null>("languages.markdown.previewFontSize");
  const [editorSize] = useSetting<number>("editor.fontSize");
  return (
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
  );
}
