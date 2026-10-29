/**
 * Model, mode, approvals and thinking-effort dropdowns for a composer's bottom row.
 * Modes and approvals use icons; levels are plain text.
 */
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Select } from "@/ui";
import { mainOptions, modeIcon } from "./composerModel";
import styles from "./Composer.module.css";

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
        return (
          <Select
            key={o.id}
            variant="ghost"
            aria-label={o.name}
            value={value}
            placeholder={tx(o.name)}
            options={o.values.map((v) => ({
              value: v.value,
              label: v.name,
              icon:
                o.category === "approval"
                  ? v.value === "bypass"
                    ? "unlock"
                    : "lock"
                  : isMode
                    ? modeIcon(v.value)
                    : undefined,
              detail: v.description ?? undefined,
            }))}
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
