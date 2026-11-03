import { Checkbox, Input } from "@/ui";
import { FolderPickerRow } from "../components/FolderPickerRow";
import { useNewProjectStore } from "../store";
import styles from "./SpringBootView.module.css";

export function EmptyProjectView() {
  const form = useNewProjectStore((s) => s.empty);
  const update = useNewProjectStore((s) => s.updateEmpty);

  return (
    <div className={styles.container}>
      <div className={styles.formGrid}>
        {/* Name */}
        <label htmlFor="empty-name" className={styles.label}>
          Name:
        </label>
        <Input
          id="empty-name"
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
      </div>
    </div>
  );
}
