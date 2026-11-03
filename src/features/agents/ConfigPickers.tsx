/**
 * Model, mode, approvals and thinking-effort dropdowns for a composer's bottom row.
 * Modes and approvals use icons; levels are plain text.
 */
import { useRef, useState } from "react";
import clsx from "clsx";
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { IconButton, Popup, Select, T } from "@/ui";
import type { SelectOption } from "@/ui/Select";
import { mainOptions, modeIcon } from "./composerModel";
import styles from "./Composer.module.css";

export function configPickerOptions(option: AgentConfigOption): SelectOption[] {
  if (option.category !== "model") {
    return option.values.map((v) => ({ value: v.value, label: v.name, detail: v.description ?? undefined }));
  }
  const groups = new Map<string, SelectOption[]>();
  for (const v of option.values) {
    const slash = v.value.indexOf("/");
    const provider = slash >= 0 ? v.value.slice(0, slash) : "";
    const path = slash >= 0 ? v.value.slice(slash + 1) : "";
    const label = path ? path.slice(path.lastIndexOf("/") + 1) : v.name || v.value;
    const detail = path ? [path, v.description].filter(Boolean).join(" · ") : (v.description ?? undefined);
    const bucket = groups.get(provider) ?? [];
    bucket.push({ value: v.value, label, detail, keywords: provider });
    groups.set(provider, bucket);
  }
  const plain = groups.get("") ?? [];
  groups.delete("");
  return [
    ...plain,
    ...[...groups].flatMap(([provider, items]) => [{ value: provider, label: provider, section: true }, ...items]),
  ];
}

export function ConfigPickers({
  config,
  values,
  onChange,
}: {
  config: readonly AgentConfigOption[];
  /** Chosen values that override `current`, by option id. */
  values?: Record<string, string>;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = mainOptions(config);
  const secondary = options.filter((o) => o.category !== "model");
  const approval = secondary.find((o) => o.category === "approval" || o.category === "mode");
  const summary = secondary
    .map((o) => {
      const value = values?.[o.id] ?? o.current;
      return `${tx(o.name)}: ${o.values.find((v) => v.value === value)?.name ?? tx("Default")}`;
    })
    .join(" · ");
  return (
    <>
      {options.map((o) => (
        <span key={o.id} className={clsx(styles.configPicker, o.category !== "model" && styles.inlineSetting)}>
          <ConfigPicker option={o} value={values?.[o.id] ?? o.current ?? null} onChange={onChange} />
        </span>
      ))}
      {secondary.length > 0 && (
        <div className={styles.settingsMenu}>
          <IconButton
            ref={anchor}
            icon={approval ? modeIcon(values?.[approval.id] ?? approval.current ?? "") : "settings"}
            title={`${tx("Agent settings")}: ${summary}`}
            aria-label={tx("Agent settings")}
            aria-haspopup="dialog"
            aria-expanded={open}
            size="small"
            onClick={() => setOpen((v) => !v)}
          />
          <Popup
            open={open}
            anchor={anchor}
            onClose={() => setOpen(false)}
            aria-label={tx("Agent settings")}
            className={styles.settingsPopup}
          >
            <div className={styles.settingsTitle}>
              <T>Agent settings</T>
            </div>
            {secondary.map((o) => (
              <div key={o.id} className={styles.settingsRow}>
                <span className={styles.settingsLabel}>{tx(o.name)}</span>
                <ConfigPicker option={o} value={values?.[o.id] ?? o.current ?? null} onChange={onChange} framed />
              </div>
            ))}
          </Popup>
        </div>
      )}
    </>
  );
}

function ConfigPicker({
  option,
  value,
  onChange,
  framed = false,
}: {
  option: AgentConfigOption;
  value: string | null;
  onChange: (option: string, value: string) => void;
  framed?: boolean;
}) {
  const tx = useTx();
  return (
    <Select
      variant={framed ? "framed" : "ghost"}
      aria-label={option.name}
      value={value}
      placeholder={tx(option.name)}
      options={configPickerOptions(option).map((opt) => ({
        ...opt,
        icon:
          option.category === "approval"
            ? opt.value === "bypass"
              ? "unlock"
              : "lock"
            : option.category === "mode"
              ? modeIcon(opt.value)
              : undefined,
      }))}
      searchable={option.category === "model"}
      onChange={(v) => onChange(option.id, v)}
      renderValue={
        option.category === "thought_level" && !framed
          ? (current) => (
              <span className={styles.pickerValue}>
                <span className={styles.pickerName}>{option.name}</span>
                {current?.label ?? tx("Default")}
              </span>
            )
          : undefined
      }
    />
  );
}
