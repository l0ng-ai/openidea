import { isTauri } from "@/platform/ipc";
import { Icon, Input } from "@/ui";
import styles from "./FolderPickerRow.module.css";

interface FolderPickerRowProps {
  location: string;
  name: string;
  onChange: (val: string) => void;
}

export function FolderPickerRow({ location, name, onChange }: FolderPickerRowProps) {
  const onBrowse = async () => {
    if (!isTauri()) {
      const manual = prompt("Enter project directory path:", location);
      if (manual) onChange(manual.trim());
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      defaultPath: location || undefined,
      title: "Select Project Location",
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (dir && typeof dir === "string") {
      onChange(dir);
    }
  };

  const sep = location.includes("/") && !location.includes("\\") ? "/" : "\\";
  const cleanLoc = location.endsWith(sep) ? location.slice(0, -1) : location;
  const fullPath = name ? `${cleanLoc}${sep}${name}` : cleanLoc;

  return (
    <div className={styles.wrapper}>
      <div className={styles.inputRow}>
        <Input
          value={location}
          onChange={(e) => onChange(e.target.value)}
          className={styles.input}
          aria-label="Location"
        />
        <button type="button" onClick={() => void onBrowse()} className={styles.browseBtn} title="Browse Folder">
          <Icon name="folder" size={16} />
        </button>
      </div>
      <div className={styles.helperText}>Project will be created in: {fullPath}</div>
    </div>
  );
}
