/** Settings › Version Control › Log: how the Git Log shows references, dates and columns. */
import { Checkbox, T } from "@/ui";
import { setLogOptions, useLogOptions, type LogOptions } from "./logOptions";
import styles from "./LogSettingsPage.module.css";
import { tx } from "@/platform/i18n";

type Flag = { [K in keyof LogOptions]: LogOptions[K] extends boolean ? K : never }[keyof LogOptions];

const OPTIONS: { key: Flag; label: string }[] = [
  { key: "compactRefs", label: "Show only the first reference" },
  { key: "tagNames", label: "Show tag names" },
  { key: "commitTimestamp", label: "Show commit time rather than author time" },
  { key: "refsOnLeft", label: "Show references on the left" },
];

const COLUMNS: { key: Flag; label: string }[] = [
  { key: "showAuthor", label: "Author" },
  { key: "showHash", label: "Hash" },
  { key: "showDate", label: "Date" },
];

export function LogSettingsPage() {
  const o = useLogOptions();
  // Display options only: the log needs no reload.
  const flag = ({ key, label }: { key: Flag; label: string }) => (
    <Checkbox key={key} checked={o[key]} onChange={(v) => setLogOptions({ [key]: v })} label={label} />
  );
  return (
    <div className={styles.page}>
      {OPTIONS.map(flag)}
      <section className={styles.section} aria-label={tx("Visible columns")}>
        <div className={styles.header}>
          <T>Visible columns:</T>
        </div>
        <div className={styles.columns}>{COLUMNS.map(flag)}</div>
      </section>
    </div>
  );
}
