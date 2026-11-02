import { Checkbox, Input } from "@/ui";
import { FolderPickerRow } from "../components/FolderPickerRow";
import { SegmentedControl } from "../components/SegmentedControl";
import { useNewProjectStore } from "../store";
import styles from "./SpringBootView.module.css";

const FRAMEWORK_OPTIONS = [
  { label: "React", value: "react" as const },
  { label: "Vue", value: "vue" as const },
  { label: "Vanilla", value: "vanilla" as const },
];

const LANG_OPTIONS = [
  { label: "TypeScript", value: "ts" as const },
  { label: "JavaScript", value: "js" as const },
];

export function ViteProjectView() {
  const form = useNewProjectStore((s) => s.vite);
  const update = useNewProjectStore((s) => s.updateVite);

  return (
    <div className={styles.container}>
      <div className={styles.formGrid}>
        {/* Name */}
        <label htmlFor="vite-name" className={styles.label}>
          Name:
        </label>
        <Input
          id="vite-name"
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

        {/* Framework */}
        <div className={styles.label}>Framework:</div>
        <SegmentedControl
          options={FRAMEWORK_OPTIONS}
          value={form.framework}
          onChange={(framework) => update({ framework })}
          aria-label="Framework"
        />

        {/* Language */}
        <div className={styles.label}>Variant:</div>
        <SegmentedControl
          options={LANG_OPTIONS}
          value={form.language}
          onChange={(language) => update({ language })}
          aria-label="Language variant"
        />
      </div>
    </div>
  );
}
