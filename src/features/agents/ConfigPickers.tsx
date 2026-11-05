/**
 * Model, mode, approvals and thinking-effort controls for a composer's bottom row.
 * With both a model and an effort option, one button shows both and opens the model
 * list and an effort slider; with a mode and an on/off permissions option (Allow All),
 * the mode menu carries the switch. Names and descriptions are the agent's own.
 */
import { useRef, useState, type CSSProperties } from "react";
import clsx from "clsx";
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, Select, T, Toggle } from "@/ui";
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

/** The on and off values of a two-state permissions option, or null when it has other values. */
function switchValues(option: AgentConfigOption): { on: string; off: string } | null {
  if (option.category !== "permissions") return null;
  const on = option.values.find((v) => /^(on|true)$/i.test(v.value))?.value;
  const off = option.values.find((v) => /^(off|false)$/i.test(v.value))?.value;
  return on && off ? { on, off } : null;
}

const selected = (option: AgentConfigOption, value: string | null) =>
  option.values.find((v) => v.value === value) ?? null;

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
  const valueOf = (o: AgentConfigOption) => values?.[o.id] ?? o.current ?? null;
  const model = options.find((o) => o.category === "model");
  const effort = model && options.find((o) => o.category === "thought_level" && o.values.length > 0);
  const mode = options.find((o) => o.category === "mode");
  const allowAll = mode && options.find((o) => switchValues(o));
  const inline = options.filter((o) => o !== effort && o !== allowAll);
  // The compact menu holds everything but the model button (which carries the effort).
  const secondary = options.filter((o) => o.category !== "model" && o !== effort);
  const approval = secondary.find((o) => o.category === "approval" || o.category === "mode");
  const summary = secondary.map((o) => `${tx(o.name)}: ${selected(o, valueOf(o))?.name ?? tx("Default")}`).join(" · ");
  return (
    <>
      {inline.map((o) => (
        <span key={o.id} className={clsx(styles.configPicker, o.category !== "model" && styles.inlineSetting)}>
          {o === model && effort ? (
            <ModelEffortPicker
              model={o}
              modelValue={valueOf(o)}
              effort={effort}
              effortValue={valueOf(effort)}
              onChange={onChange}
            />
          ) : o === mode && allowAll ? (
            <ModePicker
              mode={o}
              modeValue={valueOf(o)}
              allowAll={allowAll}
              allowAllValue={valueOf(allowAll)}
              onChange={onChange}
            />
          ) : (
            <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} />
          )}
        </span>
      ))}
      {secondary.length > 0 && (
        <div className={styles.settingsMenu}>
          <IconButton
            ref={anchor}
            icon={approval ? modeIcon(valueOf(approval) ?? "") : "settings"}
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
                <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} framed />
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
  const toggle = switchValues(option);
  if (toggle) {
    return (
      <Toggle
        checked={value === toggle.on}
        aria-label={tx(option.name)}
        label={framed ? undefined : tx(option.name)}
        onChange={(checked) => onChange(option.id, checked ? toggle.on : toggle.off)}
      />
    );
  }
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

/** One button for the model and its effort; the popup has the model list and an effort slider. */
function ModelEffortPicker({
  model,
  modelValue,
  effort,
  effortValue,
  onChange,
}: {
  model: AgentConfigOption;
  modelValue: string | null;
  effort: AgentConfigOption;
  effortValue: string | null;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const modelName = selected(model, modelValue)?.name ?? tx("Default");
  const effortName = selected(effort, effortValue)?.name ?? tx("Default");
  const summary = `${tx(model.name)}: ${modelName} · ${tx(effort.name)}: ${effortName}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.chip}
        aria-label={tx(model.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summary}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.chipValue}>{modelName}</span>
        <span className={styles.chipDetail}>{effortName}</span>
        <Icon name="chevron-down" size={14} className={styles.chipChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        placement="top-start"
        onClose={() => setOpen(false)}
        aria-label={tx("Model & effort settings")}
        className={styles.modelEffortPopup}
      >
        <div className={styles.settingsRow}>
          <span className={styles.settingsLabel}>{tx(model.name)}</span>
          <ConfigPicker option={model} value={modelValue} onChange={onChange} framed />
        </div>
        <div className={styles.effortHeader}>
          <span className={styles.settingsLabel}>{tx(effort.name)}</span>
          <span className={styles.effortValue}>{effortName}</span>
        </div>
        <EffortSlider option={effort} value={effortValue} onChange={(v) => onChange(effort.id, v)} />
      </Popup>
    </>
  );
}

/** A stepped slider over the agent's effort levels, in the order the agent lists them. */
function EffortSlider({
  option,
  value,
  onChange,
}: {
  option: AgentConfigOption;
  value: string | null;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const steps = option.values;
  const index = Math.max(
    0,
    steps.findIndex((v) => v.value === value),
  );
  const last = steps.length - 1;
  const fill = last > 0 ? (index / last) * 100 : 100;
  return (
    <div className={styles.effortSlider}>
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={index}
        aria-label={tx(option.name)}
        aria-valuetext={steps[index]?.name}
        title={steps[index]?.description ?? undefined}
        style={{ "--fill": `${fill}%` } as CSSProperties}
        onChange={(e) => {
          const next = steps[Number(e.target.value)];
          if (next && next.value !== value) onChange(next.value);
        }}
      />
      <div className={styles.effortTicks} aria-hidden>
        {steps.map((v) => (
          <span key={v.value} className={clsx(v.value === steps[index]?.value && styles.effortTickActive)} />
        ))}
      </div>
    </div>
  );
}

/** The mode menu, with the agent's on/off permissions option (Allow All) as a switch under it. */
function ModePicker({
  mode,
  modeValue,
  allowAll,
  allowAllValue,
  onChange,
}: {
  mode: AgentConfigOption;
  modeValue: string | null;
  allowAll: AgentConfigOption;
  allowAllValue: string | null;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const toggle = switchValues(allowAll)!;
  const current = selected(mode, modeValue);
  const on = allowAllValue === toggle.on;
  const summary = `${tx(mode.name)}: ${current?.name ?? tx("Default")} · ${tx(allowAll.name)}: ${on ? tx("On") : tx("Off")}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.chip}
        aria-label={tx(mode.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summary}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={on ? "unlock" : modeIcon(current?.value ?? "")} size={14} />
        <span className={styles.chipValue}>{current?.name ?? tx("Default")}</span>
        {on && <span className={styles.chipDetail}>{tx(allowAll.name)}</span>}
        <Icon name="chevron-down" size={14} className={styles.chipChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        placement="top-start"
        onClose={() => setOpen(false)}
        aria-label={tx(mode.name)}
        className={styles.modePopup}
      >
        <div role="listbox" aria-label={tx(mode.name)} className={styles.modeList}>
          {mode.values.map((v) => (
            <button
              key={v.value}
              type="button"
              role="option"
              aria-selected={v.value === current?.value}
              title={v.description ?? undefined}
              className={styles.modeOption}
              onClick={() => {
                onChange(mode.id, v.value);
                setOpen(false);
              }}
            >
              <span className={styles.modeCheck}>{v.value === current?.value && <Icon name="check" size={12} />}</span>
              <Icon name={modeIcon(v.value)} size={14} />
              <span className={styles.chipValue}>{v.name}</span>
            </button>
          ))}
        </div>
        <div className={styles.modeFooter}>
          <span title={allowAll.description ?? undefined}>{tx(allowAll.name)}</span>
          <Toggle
            checked={on}
            aria-label={tx(allowAll.name)}
            onChange={(checked) => onChange(allowAll.id, checked ? toggle.on : toggle.off)}
          />
        </div>
      </Popup>
    </>
  );
}
