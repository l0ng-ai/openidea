/**
 * Model, mode, approvals and thinking-effort dropdowns for a composer's bottom row.
 * Modes and approvals use icons; levels are plain text.
 */
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Select } from "@/ui";
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
  return (
    <>
      {mainOptions(config).map((o) => {
        const isMode = o.category === "mode";
        const value = values?.[o.id] ?? o.current ?? null;
        const options = configPickerOptions(o);

        return (
          <Select
            key={o.id}
            variant="ghost"
            aria-label={o.name}
            value={value}
            placeholder={tx(o.name)}
            options={options.map((opt) => ({
              ...opt,
              icon:
                o.category === "approval"
                  ? opt.value === "bypass"
                    ? "unlock"
                    : "lock"
                  : isMode
                    ? modeIcon(opt.value)
                    : undefined,
            }))}
            searchable={o.category === "model"}
            onChange={(v) => onChange(o.id, v)}
            // Effort and other levels say what they are: "Effort  Medium".
            renderValue={
              o.category === "thought_level"
                ? (current) => (
                    <span className={styles.pickerValue}>
                      <span className={styles.pickerName}>{o.name}</span>
                      {current?.label ?? tx("Default")}
                    </span>
                  )
                : undefined
            }
          />
        );
      })}
    </>
  );
}
