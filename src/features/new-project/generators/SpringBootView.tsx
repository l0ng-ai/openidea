import { useEffect } from "react";
import { Checkbox, Icon, Input, Select, type SelectOption } from "@/ui";
import { useDetected } from "@/features/settings/languages/components";
import { FolderPickerRow } from "../components/FolderPickerRow";
import { SegmentedControl } from "../components/SegmentedControl";
import { useNewProjectStore } from "../store";
import styles from "./SpringBootView.module.css";

const LANGUAGE_OPTIONS = [
  { label: "Java", value: "java" as const },
  { label: "Kotlin", value: "kotlin" as const },
  { label: "Groovy", value: "groovy" as const },
];

const TYPE_OPTIONS = [
  { label: "Gradle - Groovy", value: "gradle-groovy" as const },
  { label: "Gradle - Kotlin", value: "gradle-kotlin" as const },
  { label: "Maven", value: "maven" as const },
];

const PACKAGING_OPTIONS = [
  { label: "Jar", value: "jar" as const },
  { label: "War", value: "war" as const },
];

const CONFIG_OPTIONS = [
  { label: "Properties", value: "properties" as const },
  { label: "YAML", value: "yaml" as const },
];

const JAVA_VERSIONS: SelectOption[] = [
  { value: "21", label: "21" },
  { value: "17", label: "17" },
  { value: "25", label: "25" },
  { value: "11", label: "11" },
  { value: "8", label: "8" },
];

export function SpringBootView() {
  const form = useNewProjectStore((s) => s.springBoot);
  const update = useNewProjectStore((s) => s.updateSpringBoot);
  const { list: jdks, loading: loadingJdks } = useDetected("jdk");

  const jdkOptions: SelectOption[] = [
    { value: "", label: loadingJdks ? "Detecting JDKs…" : "Auto-detect system JDK" },
    ...jdks.map((jdk) => ({
      value: jdk.path,
      label: jdk.version ? `${jdk.version} (${jdk.name})` : jdk.name || jdk.path,
    })),
  ];

  // Auto-select first detected JDK if form.jdk is empty
  useEffect(() => {
    if (!form.jdk && jdks.length > 0 && jdks[0]?.path) {
      update({ jdk: jdks[0].path });
    }
  }, [jdks, form.jdk, update]);

  return (
    <div className={styles.container}>
      <div className={styles.formGrid}>
        {/* Server URL */}
        <div className={styles.label}>Server URL:</div>
        <div className={styles.serverRow}>
          <span className={styles.serverLink}>{form.serverUrl}</span>
          <button
            type="button"
            className={styles.gearBtn}
            title="Spring Initializr settings"
            onClick={() => {
              const url = prompt("Spring Initializr Server URL:", form.serverUrl);
              if (url) update({ serverUrl: url.trim() });
            }}
          >
            <Icon name="settings" size={14} />
          </button>
        </div>

        {/* Name */}
        <label htmlFor="sb-name" className={styles.label}>
          Name:
        </label>
        <Input
          id="sb-name"
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

        {/* Language */}
        <div className={styles.label}>Language:</div>
        <SegmentedControl
          options={LANGUAGE_OPTIONS}
          value={form.language}
          onChange={(language) => update({ language })}
          aria-label="Programming Language"
        />

        {/* Type */}
        <div className={styles.label}>Type:</div>
        <SegmentedControl
          options={TYPE_OPTIONS}
          value={form.type}
          onChange={(type) => update({ type })}
          aria-label="Build System"
        />

        {/* Group */}
        <label htmlFor="sb-group" className={styles.label}>
          Group:{" "}
          <span className={styles.helpIcon} title="Group ID (e.g. com.example)">
            ?
          </span>
        </label>
        <Input
          id="sb-group"
          value={form.group}
          onChange={(e) => update({ group: e.target.value })}
          className={styles.inputField}
        />

        {/* Artifact */}
        <label htmlFor="sb-artifact" className={styles.label}>
          Artifact:{" "}
          <span className={styles.helpIcon} title="Artifact ID">
            ?
          </span>
        </label>
        <Input
          id="sb-artifact"
          value={form.artifact}
          onChange={(e) => update({ artifact: e.target.value })}
          className={styles.inputField}
        />

        {/* Package name */}
        <label htmlFor="sb-package" className={styles.label}>
          Package name:
        </label>
        <Input
          id="sb-package"
          value={form.packageName}
          onChange={(e) => update({ packageName: e.target.value })}
          className={styles.inputField}
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

        {/* Java Version */}
        <label className={styles.label}>Java:</label>
        <Select
          options={JAVA_VERSIONS}
          value={form.javaVersion}
          onChange={(val) => update({ javaVersion: val })}
          className={styles.selectField}
        />

        {/* Packaging */}
        <div className={styles.label}>Packaging:</div>
        <SegmentedControl
          options={PACKAGING_OPTIONS}
          value={form.packaging}
          onChange={(packaging) => update({ packaging })}
          aria-label="Packaging"
        />

        {/* Configuration */}
        <div className={styles.label}>Configuration:</div>
        <SegmentedControl
          options={CONFIG_OPTIONS}
          value={form.configuration}
          onChange={(configuration) => update({ configuration })}
          aria-label="Configuration format"
        />
      </div>
    </div>
  );
}
