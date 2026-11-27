/**
 * Settings › Python › Testing: the test runner of gutter and context-menu runs in projects
 * without a test configuration of their own (PyCharm's "Default test runner").
 */
import { Section, SettingSelect } from "../components/Form";

const RUNNERS = [
  { value: "auto", label: "Autodetect" },
  { value: "pytest", label: "pytest" },
  { value: "unittest", label: "unittest" },
] as const;

export function PythonTestingPage() {
  return (
    <Section>
      <SettingSelect
        k="languages.python.testRunner"
        label="Default test runner"
        hint="Runs tests from the gutter and the context menu. Autodetect uses pytest when the project uses it, else unittest, except for modules that don't import unittest."
        options={RUNNERS}
      />
    </Section>
  );
}
