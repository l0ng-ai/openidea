/**
 * Settings › Python › Docstrings: the markup format the editor highlights in
 * documentation strings (PyCharm's "Python › Docstrings" page).
 */
import type { SelectOption } from "@/ui";
import { DOCSTRING_FORMATS, type DocstringFormat } from "@/platform/editorSettings";
import { Section, SettingSelect } from "../components/Form";

const DOCSTRING_LABELS: Record<DocstringFormat, string> = {
  plain: "Plain",
  rest: "reStructuredText",
  epytext: "Epytext",
  google: "Google",
  numpy: "NumPy",
};
const DOCSTRING_OPTIONS: readonly SelectOption<DocstringFormat>[] = DOCSTRING_FORMATS.map((value) => ({
  value,
  label: DOCSTRING_LABELS[value],
}));

export function DocstringsPage() {
  return (
    <Section>
      <SettingSelect
        k="editor.docstringFormat"
        label="Documentation string format"
        hint={
          'Docstring stubs (Enter after """) are written in this markup format, and docstring tags and keywords are highlighted according to it (Color Scheme › Python styles their colours).'
        }
        options={DOCSTRING_OPTIONS}
      />
    </Section>
  );
}
