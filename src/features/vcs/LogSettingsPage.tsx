/** Settings › Version Control › Log: how the Git Log shows references, dates and columns. */
import { useId, type ReactNode } from "react";
import { Checkbox, T } from "@/ui";
import { setLogOptions, useLogOptions, type LogOptions } from "./logOptions";
import styles from "./LogSettingsPage.module.css";

type Flag = { [K in keyof LogOptions]: LogOptions[K] extends boolean ? K : never }[keyof LogOptions];

const OPTIONS: { key: Flag; label: string }[] = [
  { key: "compactRefs", label: "Show only the first reference" },
  { key: "tagNames", label: "Show tag names" },
  { key: "commitTimestamp", label: "Show commit time rather than author time" },
  { key: "refsOnLeft", label: "Show references on the left" },
  { key: "showLineStats", label: "Show lines added and deleted" },
];

const COLUMNS: { key: Flag; label: string }[] = [
  { key: "showAuthor", label: "Author" },
  { key: "showHash", label: "Hash" },
  { key: "showDate", label: "Date" },
  { key: "showGitHubChecks", label: "GitHub Commit Checks" },
];

function OptionGroup({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading} className={styles.heading}>
        <T>{title}</T>
      </h2>
      <div className={styles.options}>{children}</div>
    </section>
  );
}

export function LogSettingsPage() {
  const o = useLogOptions();
  // Display options only: the log needs no reload.
  const flag = ({ key, label }: { key: Flag; label: string }) => (
    <Checkbox key={key} checked={o[key]} onChange={(v) => setLogOptions({ [key]: v })} label={label} />
  );
  return (
    <div className={styles.page}>
      <OptionGroup title="View Options">{OPTIONS.map(flag)}</OptionGroup>
      <OptionGroup title="Visible columns">{COLUMNS.map(flag)}</OptionGroup>
    </div>
  );
}
