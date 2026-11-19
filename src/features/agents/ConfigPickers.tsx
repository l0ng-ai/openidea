/**
 * Model, effort, mode and approvals controls for a composer's bottom row. The model button
 * opens a searchable model list (pinned models first) and keeps effort and context settings
 * together above it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, Select, T, Toggle } from "@/ui";
import { SelectListbox, type SelectOption } from "@/ui/Select";
import { isContextOption, mainOptions, modelConfigOptions, modeIcon } from "./composerModel";
import { togglePinnedModel, useAgents } from "./store";
import styles from "./Composer.module.css";

export function configPickerOptions(
  option: AgentConfigOption,
  pinned: readonly string[] = [],
  /** Without each model's description: the model popup lists names only. */
  descriptions = true,
): SelectOption[] {
  if (option.category !== "model") {
    return option.values.map((v) => ({ value: v.value, label: v.name, detail: v.description ?? undefined }));
  }
  const pinnedSet = new Set(pinned);
  const buildItem = (v: AgentConfigOption["values"][number]): { provider: string; opt: SelectOption } => {
    const slash = v.value.indexOf("/");
    const provider = slash >= 0 ? v.value.slice(0, slash) : "";
    const path = slash >= 0 ? v.value.slice(slash + 1) : "";
    // Prefer the agent-reported display name (e.g. "opencode/Beam Free" → "Beam Free"); agents
    // that just echo the id keep the compact id tail. The raw id stays in the detail line.
    const prefix = provider ? `${provider}/` : "";
    const reported = v.name.startsWith(prefix) ? v.name.slice(prefix.length).trim() : v.name;
    const label = path
      ? reported && reported !== path
        ? reported
        : path.slice(path.lastIndexOf("/") + 1)
      : v.name || v.value;
    const mult = v.usageMultiplier && !v.description?.startsWith(v.usageMultiplier) ? v.usageMultiplier : undefined;
    const parts = [path || undefined, mult, (descriptions && v.description) || undefined].filter(
      (p): p is string => !!p,
    );
    const detail = parts.length > 0 ? parts.join(" · ") : undefined;
    return { provider, opt: { value: v.value, label, detail, keywords: provider } };
  };

  const pinnedItems: SelectOption[] = [];
  const groups = new Map<string, SelectOption[]>();
  for (const v of option.values) {
    const { provider, opt } = buildItem(v);
    if (pinnedSet.has(v.value)) {
      pinnedItems.push(opt);
      continue;
    }
    const bucket = groups.get(provider) ?? [];
    bucket.push(opt);
    groups.set(provider, bucket);
  }
  const plain = groups.get("") ?? [];
  groups.delete("");
  return [
    ...(pinnedItems.length > 0 ? [{ value: "__pinned__", label: "Pinned", section: true }, ...pinnedItems] : []),
    ...(pinnedItems.length > 0 && plain.length > 0 ? [{ value: "__models__", label: "Models", section: true }] : []),
    ...plain,
    ...[...groups].flatMap(([provider, items]) => [{ value: provider, label: provider, section: true }, ...items]),
  ];
}

/** The on and off values of a two-state permissions or fast option, or null when it has other values. */
function switchValues(option: AgentConfigOption): { on: string; off: string } | null {
  const isFast = option.id === "fast" || (option.category === "model_config" && !isContextOption(option.id));
  if (option.category !== "permissions" && !isFast) return null;
  const on = option.values.find((v) => /^(on|true)$/i.test(v.value))?.value;
  const off = option.values.find((v) => /^(off|false)$/i.test(v.value))?.value;
  return on && off ? { on, off } : null;
}

const selected = (option: AgentConfigOption, value: string | null) =>
  option.values.find((v) => v.value === value) ?? null;

interface ModelRefresh {
  draft?: boolean;
  refreshing: boolean;
  loadingSettings?: boolean;
  retryAtMs: number | null;
  error: string | null;
  onOpen?: () => void;
  onRefresh: () => void;
}

export function ConfigPickers({
  config,
  values,
  onChange,
  modelRefresh,
}: {
  config: readonly AgentConfigOption[];
  /** Chosen values that override `current`, by option id. */
  values?: Record<string, string>;
  onChange: (option: string, value: string) => void;
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = mainOptions(config);
  if (modelRefresh?.draft && !options.some((o) => o.category === "model"))
    options.unshift({
      id: "model",
      name: "Model",
      category: "model",
      description: null,
      current: null,
      values: [],
      via: "option",
    });
  const valueOf = (o: AgentConfigOption) => values?.[o.id] ?? o.current ?? null;
  const model = options.find((o) => o.category === "model");
  const effort = config.find((o) => o.category === "thought_level" && o.values.length > 0);
  const modelConfigs = modelConfigOptions(config);
  const hasCostMeta = model?.values.some((v) => !!v.costCategory || !!v.usageMultiplier || !!v.pricing) ?? false;
  const combinedModel = !!model && (!!modelRefresh || modelConfigs.length > 0 || hasCostMeta || !!effort);
  const tuckedEffort = combinedModel ? (effort ?? null) : null;
  const tuckedModelConfig = new Set(modelConfigs.map((o) => o.id));
  const mode = options.find((o) => o.category === "mode");
  const allowAll = mode && options.find((o) => switchValues(o));
  const inline = options.filter(
    (o) => o !== effort && o !== allowAll && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  if (effort && !tuckedEffort) inline.splice(model ? inline.indexOf(model) + 1 : 0, 0, effort);
  // The compact menu holds everything but the model, effort, and model-specific parameters.
  const secondary = options.filter(
    (o) => o.category !== "model" && o !== effort && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  const approval = secondary.find((o) => o.category === "approval" || o.category === "mode");
  const summary = secondary.map((o) => `${tx(o.name)}: ${selected(o, valueOf(o))?.name ?? tx("Default")}`).join(" · ");
  return (
    <>
      {inline.map((o) => (
        <span
          key={o.id}
          className={clsx(styles.configPicker, o.category !== "model" && o !== effort && styles.inlineSetting)}
        >
          {o === model && combinedModel ? (
            <ModelPicker
              model={o}
              modelValue={valueOf(o)}
              modelConfigs={modelConfigs}
              effort={tuckedEffort}
              effortValue={tuckedEffort ? valueOf(tuckedEffort) : null}
              valueOf={valueOf}
              onChange={onChange}
              modelRefresh={modelRefresh}
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
          {o === model && modelRefresh?.loadingSettings && (
            <span className={styles.pickerValue} role="status">
              <T>Loading model settings…</T>
            </span>
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
          ? (current) => <span className={styles.pickerValue}>{current?.label ?? tx("Default")}</span>
          : undefined
      }
    />
  );
}

/** Effort levels that fit the popup's segmented control; more (Codex has six) get a dropdown. */
const SEGMENTED_EFFORT_MAX = 4;

/** The model button: a searchable model list, with effort, context size and model settings above it. */
function ModelPicker({
  model,
  modelValue,
  modelConfigs,
  effort,
  effortValue,
  valueOf,
  onChange,
  modelRefresh,
}: {
  model: AgentConfigOption;
  modelValue: string | null;
  modelConfigs: AgentConfigOption[];
  effort: AgentConfigOption | null;
  effortValue: string | null;
  valueOf: (o: AgentConfigOption) => string | null;
  onChange: (option: string, value: string) => void;
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const pinnedModels = useAgents((s) => s.pinnedModels);
  const anchor = useRef<HTMLButtonElement>(null);
  const selectedModel = selected(model, modelValue);
  const unavailable = modelRefresh?.draft && modelValue !== null && !selectedModel;
  const modelName = unavailable
    ? tx`${modelValue} (unavailable)`
    : (selectedModel?.name ?? (modelRefresh ? modelValue : null) ?? tx("Default"));

  const contextOption = modelConfigs.find((o) => isContextOption(o.id) && o.values.length > 0);
  const contextValue = contextOption ? valueOf(contextOption) : null;
  const contextLabel = contextOption
    ? ((selected(contextOption, contextValue) ?? contextOption.values[0])?.name ?? null)
    : null;
  const effortLabel = effort ? ((selected(effort, effortValue) ?? effort.values[0])?.name ?? null) : null;
  const otherModelConfigs = modelConfigs.filter((o) => o !== contextOption);
  const summary = [
    effortLabel ? `${tx("Effort Level")}: ${effortLabel}` : null,
    contextLabel ? `${tx("Context Size")}: ${contextLabel}` : null,
    ...otherModelConfigs.map((o) => {
      const current = selected(o, valueOf(o));
      return current ? `${tx(o.name)}: ${current.name}` : null;
    }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.chip}
        aria-label={tx(model.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${tx(model.name)}: ${modelName}${summary ? ` · ${summary}` : ""}`}
        onClick={() => {
          if (!open) modelRefresh?.onOpen?.();
          setOpen(!open);
        }}
      >
        <span className={styles.chipValue}>{modelName}</span>
        {(effortLabel || contextLabel) && (
          <span className={clsx(styles.chipDetail, styles.modelDetail)}>
            {[effortLabel, contextLabel].filter(Boolean).join(" · ")}
          </span>
        )}
        <Icon name="chevron-down" size={14} className={styles.chipChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        onClose={() => setOpen(false)}
        aria-label={tx("Model")}
        className={styles.modelEffortPopup}
      >
        {unavailable && (
          <p className={styles.catalogError} role="alert">
            <T>Choose another model before starting.</T>
          </p>
        )}
        {(effort || contextOption || otherModelConfigs.length > 0) && (
          <div className={styles.quickSettings}>
            {effort && (
              <div className={styles.quickRow}>
                <span className={styles.quickLabel}>
                  <T>Effort Level</T>
                </span>
                {effort.values.length <= SEGMENTED_EFFORT_MAX ? (
                  <SegmentedControl
                    ariaLabel={tx("Effort Level")}
                    options={effort.values.map((v) => ({
                      value: v.value,
                      label: v.name,
                      description: v.description ?? undefined,
                    }))}
                    value={effortValue ?? effort.values[0]!.value}
                    onChange={(v) => onChange(effort.id, v)}
                  />
                ) : (
                  <ConfigPicker option={effort} value={effortValue} onChange={onChange} framed />
                )}
              </div>
            )}
            {contextOption && (
              <div className={styles.quickRow}>
                <span className={styles.quickLabel}>
                  <T>Context Size</T>
                </span>
                <SegmentedControl
                  ariaLabel={tx("Context Size")}
                  options={contextOption.values.map((v) => ({
                    value: v.value,
                    label: v.name,
                    description: v.description ?? undefined,
                  }))}
                  value={contextValue ?? contextOption.values[0]!.value}
                  onChange={(v) => onChange(contextOption.id, v)}
                />
              </div>
            )}
            {otherModelConfigs.map((o) => (
              <div key={o.id} className={styles.quickRow}>
                <span className={styles.quickLabel} title={o.description ?? undefined}>
                  {tx(o.name)}
                </span>
                <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} framed />
              </div>
            ))}
          </div>
        )}
        {model.values.length > 0 || !modelRefresh ? (
          <SelectListbox
            aria-label={tx(model.name)}
            value={modelValue}
            options={configPickerOptions(model, pinnedModels, false)}
            searchable
            listClassName={styles.modelList}
            onChoose={(v) => {
              onChange(model.id, v);
              setOpen(false);
            }}
            renderAction={(opt) => {
              const raw = model.values.find((v) => v.value === opt.value);
              if (!raw) return null;
              const pinned = pinnedModels.includes(raw.value);
              return (
                <>
                  <CostBadge category={raw.costCategory} />
                  <button
                    type="button"
                    className={clsx(styles.modelRowConfigure, pinned && styles.pinnedButton)}
                    aria-label={pinned ? tx("Unpin model") : tx("Pin model")}
                    aria-pressed={pinned}
                    title={pinned ? tx("Unpin model") : tx("Pin model")}
                    onClick={() => togglePinnedModel(raw.value)}
                  >
                    <Icon name="pin" size={12} />
                  </button>
                </>
              );
            }}
          />
        ) : (
          <p className={styles.catalogNote} role="status">
            {modelRefresh?.refreshing ? <T>Loading models…</T> : <T>No models reported by this agent.</T>}
          </p>
        )}
        {modelRefresh && <ModelRefreshFooter key={modelRefresh.retryAtMs} {...modelRefresh} />}
      </Popup>
    </>
  );
}

function ModelRefreshFooter({ refreshing, retryAtMs, error, onRefresh }: ModelRefresh) {
  const tx = useTx();
  const [now, setNow] = useState(Date.now);
  const remaining = retryAtMs == null ? 0 : Math.max(0, Math.ceil((retryAtMs - now) / 1000));
  const coolingDown = remaining > 0;
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [retryAtMs, coolingDown]);
  return (
    <div className={styles.catalogFooter}>
      {error && (
        <p className={styles.catalogError} role="alert">
          {tx`Could not refresh models: ${error}`}
        </p>
      )}
      <button type="button" className={styles.refreshModels} disabled={refreshing || coolingDown} onClick={onRefresh}>
        {refreshing ? tx("Refreshing…") : coolingDown ? tx`Refresh in ${remaining}s` : tx("Refresh models")}
      </button>
    </div>
  );
}

function CostBadge({ category }: { category: string | null | undefined }) {
  if (!category) return null;
  const label =
    category === "free" ? (
      <T>Free</T>
    ) : category === "low" ? (
      <T>Low cost</T>
    ) : category === "medium" ? (
      <T>Medium cost</T>
    ) : category === "high" ? (
      <T>High cost</T>
    ) : category === "very_high" ? (
      <T>Very high cost</T>
    ) : null;
  if (!label) return null;
  return (
    <span
      className={clsx(
        styles.costBadge,
        (category === "free" || category === "low") && styles.costBadgeLow,
        (category === "high" || category === "very_high") && styles.costBadgeHigh,
      )}
    >
      {label}
    </span>
  );
}

/** Accessible segmented pill selector (`role="radiogroup"`) with Left/Right arrow navigation. */
export function SegmentedControl({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: readonly { value: string; label: string; description?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (currentIndex + delta + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div ref={groupRef} role="radiogroup" aria-label={ariaLabel} className={styles.segmented} onKeyDown={onKeyDown}>
      {options.map((opt, idx) => {
        const active = idx === currentIndex;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={opt.description}
            className={clsx(styles.segment, active && styles.segmentActive)}
            onClick={() => {
              if (opt.value !== value) onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        );
      })}
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
