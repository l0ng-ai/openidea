/** Right-hand options for one New Project kind. Mirrors PhpStorm's generator forms. */
import { Checkbox, IconButton, Input, Select, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import { projectFields, type CheckItem, type ProjectField } from "./newProjectOptions";
import styles from "./app.module.css";

export function ProjectOptions({
  kindId,
  values,
  onChange,
  git,
  onGit,
  onBrowse,
  browseDisabled,
}: {
  kindId: string;
  values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean) => void;
  git: boolean;
  onGit: (checked: boolean) => void;
  onBrowse: (id: string) => void;
  browseDisabled: boolean;
}) {
  const tx = useTx();
  const fields = projectFields(kindId);
  if (!fields.length) return null;
  return (
    <div className={styles.optionList}>
      {fields.map((field, index) => (
        <Field
          key={fieldKey(field, index)}
          field={field}
          values={values}
          onChange={onChange}
          git={git}
          onGit={onGit}
          onBrowse={onBrowse}
          browseDisabled={browseDisabled}
          tx={tx}
        />
      ))}
    </div>
  );
}

function fieldKey(field: ProjectField, index: number): string {
  if (field.type === "git" || field.type === "cli") return field.type;
  if (field.type === "checks") return field.title ?? `checks-${index}`;
  return field.id;
}

function Field({
  field,
  values,
  onChange,
  git,
  onGit,
  onBrowse,
  browseDisabled,
  tx,
}: {
  field: ProjectField;
  values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean) => void;
  git: boolean;
  onGit: (checked: boolean) => void;
  onBrowse: (id: string) => void;
  browseDisabled: boolean;
  tx: (text: string) => string;
}) {
  if (field.type === "git") return <Checkbox checked={git} onChange={onGit} label="Initialize Git repo" />;
  if (field.type === "select") {
    return (
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{tx(field.label)}</span>
        <Select
          aria-label={field.label}
          value={String(values[field.id] ?? field.default)}
          options={field.options.map((option) => ({ value: option, label: option }))}
          onChange={(value) => onChange(field.id, value)}
          disabled={field.id === "packageVersion" && !String(values.packageName ?? "").trim()}
        />
      </div>
    );
  }
  if (field.type === "text") {
    return (
      <label className={styles.formRow}>
        <span className={styles.formLabel}>{tx(field.label)}</span>
        <Input
          aria-label={field.label}
          value={String(values[field.id] ?? "")}
          onChange={(e) => onChange(field.id, e.target.value)}
        />
      </label>
    );
  }
  if (field.type === "radios") {
    return (
      <div className={styles.radioRow}>
        {field.options.map((option) => (
          <label key={option} className={styles.radio}>
            <input
              type="radio"
              name={field.id}
              checked={values[field.id] === option}
              onChange={() => onChange(field.id, option)}
            />
            <span>{tx(option)}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.type === "path") {
    return (
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{tx(field.label)}</span>
        <Input
          aria-label={field.label}
          value={String(values[field.id] ?? "")}
          onChange={(e) => onChange(field.id, e.target.value)}
        />
        <IconButton icon="folder" title="Browse…" disabled={browseDisabled} onClick={() => onBrowse(field.id)} />
      </div>
    );
  }
  if (field.type === "cli") {
    return (
      <>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>
            <T>Node runtime:</T>
          </span>
          <Select
            aria-label="Node runtime"
            value="node"
            options={[{ value: "node", label: "node" }]}
            onChange={() => {}}
          />
        </div>
        <label className={styles.formRow}>
          <span className={styles.formLabel}>{tx(field.commandLabel)}</span>
          <Input
            aria-label={field.commandLabel}
            value={String(values.command ?? field.command)}
            onChange={(e) => onChange("command", e.target.value)}
          />
        </label>
        <Checkbox
          checked={values.defaultSetup !== false}
          onChange={(checked) => onChange("defaultSetup", checked)}
          label="Use the default project setup"
        />
      </>
    );
  }
  return (
    <div className={styles.checkBlock}>
      {field.title && <div className={styles.checkTitle}>{tx(field.title)}</div>}
      <div className={styles.checkGrid}>
        {field.columns.map((column, columnIndex) => (
          <div key={columnIndex} className={styles.checkColumn}>
            {column.map((item) => (
              <CheckRow key={item.id} item={item} values={values} onChange={onChange} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckRow({
  item,
  values,
  onChange,
}: {
  item: CheckItem;
  values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean) => void;
}) {
  const open = values[`${item.id}.open`] === true;
  return (
    <div className={styles.checkLine}>
      <Checkbox
        checked={values[item.id] === true}
        onChange={(checked) => onChange(item.id, checked)}
        label={item.label}
      />
      {item.configure && (
        <button type="button" className={styles.configure} onClick={() => onChange(`${item.id}.open`, !open)}>
          <T>Configure</T>
        </button>
      )}
      {open && item.configure === "services" && (
        <Input
          aria-label="Services"
          value={String(values[`${item.id}.detail`] ?? "mysql")}
          onChange={(e) => onChange(`${item.id}.detail`, e.target.value)}
        />
      )}
      {open && item.configure === "panel" && (
        <Input
          aria-label="Panel"
          value={String(values[`${item.id}.detail`] ?? "admin")}
          onChange={(e) => onChange(`${item.id}.detail`, e.target.value)}
        />
      )}
      {open && item.configure === "driver" && (
        <Select
          aria-label="Driver"
          value={String(values[`${item.id}.detail`] ?? "database")}
          options={[
            { value: "database", label: "database" },
            { value: "meilisearch", label: "meilisearch" },
            { value: "algolia", label: "algolia" },
          ]}
          onChange={(value) => onChange(`${item.id}.detail`, value)}
        />
      )}
    </div>
  );
}
