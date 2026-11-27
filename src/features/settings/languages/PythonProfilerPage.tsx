/**
 * Settings › Python › Profiler: what Profile runs a Python configuration under. PyCharm picks
 * the profiler from what the interpreter has installed; Automatic does the same.
 */
import { Section, SettingSelect } from "../components/Form";

const PROFILERS = [
  { value: "auto", label: "Automatic" },
  { value: "cprofile", label: "cProfile" },
  { value: "py-spy", label: "py-spy" },
] as const;

export function PythonProfilerPage() {
  return (
    <Section>
      <SettingSelect
        k="languages.python.profiler"
        label="Profiler"
        hint="Automatic uses py-spy where it is installed and can sample without root (not on macOS), else cProfile from the standard library."
        options={PROFILERS}
      />
    </Section>
  );
}
