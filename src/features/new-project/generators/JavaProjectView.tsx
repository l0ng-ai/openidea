import { Checkbox, Input, Select, type SelectOption } from "@/ui";
import { useDetected } from "@/features/settings/languages/components";
import { FolderPickerRow } from "../components/FolderPickerRow";
import { SegmentedControl } from "../components/SegmentedControl";
import { useNewProjectStore } from "../store";
import styles from "./SpringBootView.module.css";

const BUILD_OPTIONS = [
  { label: "Maven", value: "maven" as const },
  { label: "Gradle", value: "gradle" as const },
];

export function JavaProjectView({ language = "Java" }: { language?: string }) {
  const form = useNewProjectStore((s) => s.java);
  const update = useNewProjectStore((s) => s.updateJava);
  const { list: jdks, loading: loadingJdks } = useDetected("jdk");

  const jdkOptions: SelectOption[] = [
    { value: "", label: loadingJdks ? "Detecting JDKs…" : "Auto-detect system JDK" },
    ...jdks.map((jdk) => ({
      value: jdk.path,
      label: jdk.version ? `${jdk.version} (${jdk.name})` : jdk.name || jdk.path,
    })),
  ];

  return (
    <div className={styles.container}>
      <div className={styles.formGrid}>
        {/* Name */}
        <label htmlFor="java-name" className={styles.label}>
          Name:
        </label>
        <Input
          id="java-name"
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          className={styles.inputField}
          autoFocus
        />

        {/* Location */}
        <label className={styles.label}>Location:</label>
        <FolderPickerRow location={form.location} name={form.name} onChange={(location) => update({ location })} />

        {/* Git Checkbox */}
        <label className={styles.checkboxRow}>
          <Checkbox checked={form.createGit} onChange={(checked) => update({ createGit: checked })} />
          <span>Create Git repository</span>
        </label>

        {/* Language Display */}
        <div className={styles.label}>Language:</div>
        <div style={{ fontSize: "13px", fontWeight: 500 }}>{language}</div>

        {/* Build system */}
        <div className={styles.label}>Build system:</div>
        <SegmentedControl
          options={BUILD_OPTIONS}
          value={form.buildSystem}
          onChange={(buildSystem) => update({ buildSystem })}
          aria-label="Build System"
        />

        {/* JDK */}
        <label className={styles.label}>JDK:</label>
        <div className={styles.jdkRow}>
          <Select
            options={jdkOptions}
            value={form.jdk}
            onChange={(val) => update({ jdk: val })}
            className={styles.selectField}
          />
        </div>

        {/* Sample code */}
        <label className={styles.checkboxRow}>
          <Checkbox checked={form.addSampleCode} onChange={(checked) => update({ addSampleCode: checked })} />
          <span>Add sample code</span>
        </label>
      </div>
    </div>
  );
}
