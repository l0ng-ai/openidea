/**
 * Model and settings controls shared by the New Task and session composers.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, Select, T, Toggle } from "@/ui";
import { SelectListbox, type SelectOption } from "@/ui/Select";
import { Spinner } from "@/ui/Spinner";
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

interface ModeApprovalSwitch {
  on: string;
  off: string;
  /** Switch label inside the Mode popup footer (e.g. "Allow All", "Bypass approvals"). */
  label: string;
  /** Concise detail shown on the Mode chip when enabled (e.g. "Allow All", "Bypass"). */
  chipLabel: string;
}

/** A two-state permissions or approval option tucked as a switch inside the Mode popup. */
function modeApprovalSwitch(option: AgentConfigOption): ModeApprovalSwitch | null {
  if (option.category === "permissions") {
    const sw = switchValues(option);
    return sw ? { ...sw, label: option.name, chipLabel: option.name } : null;
  }
  if (option.category === "approval" && option.values.length === 2) {
    const on = option.values.find((v) => v.value.toLowerCase() === "bypass");
    const off = option.values.find((v) => v !== on);
    if (on && off) {
      return { on: on.value, off: off.value, label: on.name || option.name, chipLabel: "Bypass" };
    }
  }
  return null;
}

export interface OverflowInput {
  available: number;
  gap: number;
  fixedWidths: readonly number[];
  secondaryWidths: readonly number[];
  detailWidth: number;
  detailIndex: number;
  menuWidth: number;
}

export interface OverflowLayout {
  /** Hide secondary detail text inside chips (e.g. "Allow All" / "Bypass") before collapsing items. */
  compactDetail: boolean;
  /** Number of trailing secondary items moved into the overflow settings menu. */
  collapsedCount: number;
}

/**
 * Decides how many secondary pickers fit on a single toolbar row before spilling into the
 * settings menu: first drops optional chip detail labels, then collapses trailing secondary
 * items one by one from right to left.
 */
export function computeOverflowLayout({
  available,
  gap,
  fixedWidths,
  secondaryWidths,
  detailWidth,
  detailIndex,
  menuWidth,
}: OverflowInput): OverflowLayout {
  if (available <= 0 || secondaryWidths.length === 0) {
    return { compactDetail: false, collapsedCount: 0 };
  }

  const fixedCount = fixedWidths.length;
  const fixedTotal = fixedWidths.reduce((sum, w) => sum + w, 0);

  const widthFor = (kept: number, compactDetail: boolean): number => {
    const hasMenu = kept < secondaryWidths.length;
    const itemCount = fixedCount + kept + (hasMenu ? 1 : 0);
    if (itemCount === 0) return 0;
    let total = fixedTotal;
    for (let i = 0; i < kept; i++) total += secondaryWidths[i]!;
    if (compactDetail && detailWidth > 0 && detailIndex >= 0 && detailIndex < kept) {
      total -= detailWidth;
    }
    if (hasMenu) total += menuWidth;
    return total + gap * (itemCount - 1);
  };

  if (widthFor(secondaryWidths.length, false) <= available) {
    return { compactDetail: false, collapsedCount: 0 };
  }
  if (detailWidth > 0 && detailIndex >= 0 && widthFor(secondaryWidths.length, true) <= available) {
    return { compactDetail: true, collapsedCount: 0 };
  }

  for (let collapsed = 1; collapsed <= secondaryWidths.length; collapsed++) {
    const kept = secondaryWidths.length - collapsed;
    if (kept === 0) return { compactDetail: false, collapsedCount: collapsed };
    if (widthFor(kept, false) <= available) {
      return { compactDetail: false, collapsedCount: collapsed };
    }
    if (detailWidth > 0 && detailIndex >= 0 && detailIndex < kept && widthFor(kept, true) <= available) {
      return { compactDetail: true, collapsedCount: collapsed };
    }
  }

  return { compactDetail: false, collapsedCount: secondaryWidths.length };
}

const selected = (option: AgentConfigOption, value: string | null) =>
  option.values.find((v) => v.value === value) ?? null;

type ChangeOption = (option: string, value: string) => void;

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
  onChange: ChangeOption;
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState<OverflowLayout>({ compactDetail: false, collapsedCount: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
  const allowAll = mode && options.find((o) => !!modeApprovalSwitch(o));
  const inline = options.filter(
    (o) => o !== effort && o !== allowAll && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  if (effort && !tuckedEffort) inline.splice(model ? inline.indexOf(model) + 1 : 0, 0, effort);
  const collapsible = inline.filter((o) => o.category !== "model" && o !== effort);
  // The overflow menu holds everything except the model, effort, and model-specific parameters.
  const secondary = options.filter(
    (o) => o.category !== "model" && o !== effort && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  const signature = [
    ...inline.map((o) => `${o.id}:${valueOf(o) ?? ""}`),
    ...(tuckedEffort ? [`${tuckedEffort.id}:${valueOf(tuckedEffort) ?? ""}`] : []),
    ...modelConfigs.map((o) => `${o.id}:${valueOf(o) ?? ""}`),
    allowAll ? `${allowAll.id}:${valueOf(allowAll) ?? ""}` : "",
    modelRefresh?.loadingSettings ? "loading" : "",
  ].join("|");

  useLayoutEffect(() => {
    const menuEl = menuRef.current;
    const toolbar = menuEl?.closest<HTMLElement>("[data-composer-toolbar]");
    if (!toolbar) return;

    const measure = () => {
      const style = getComputedStyle(toolbar);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const available = toolbar.getBoundingClientRect().width - padX;
      if (available <= 0) return;

      toolbar.classList.add(styles.toolbarMeasuring!);
      const gap = parseFloat(style.columnGap) || 0;
      const fixedWidths: number[] = [];
      const secondaryWidths: number[] = [];
      let detailWidth = 0;
      let detailIndex = -1;
      let menuWidth = 0;

      for (const child of Array.from(toolbar.children) as HTMLElement[]) {
        if (child.hasAttribute("data-config-menu")) {
          menuWidth = child.getBoundingClientRect().width;
          continue;
        }
        if (child.hasAttribute("data-config-secondary")) {
          const idx = secondaryWidths.length;
          secondaryWidths.push(child.getBoundingClientRect().width);
          const detail = child.querySelector<HTMLElement>("[data-chip-detail]");
          if (detail) {
            const chipGap = parseFloat(getComputedStyle(detail.parentElement!).columnGap) || 0;
            detailWidth = detail.getBoundingClientRect().width + chipGap;
            detailIndex = idx;
          }
          continue;
        }
        const w = child.getBoundingClientRect().width;
        if (w > 0) fixedWidths.push(w);
      }

      toolbar.classList.remove(styles.toolbarMeasuring!);

      const next = computeOverflowLayout({
        available,
        gap,
        fixedWidths,
        secondaryWidths,
        detailWidth,
        detailIndex,
        menuWidth,
      });
      setOverflow((prev) => {
        if (prev.compactDetail === next.compactDetail && prev.collapsedCount === next.collapsedCount) return prev;
        if (prev.collapsedCount > 0 && next.collapsedCount === 0) setOpen(false);
        return next;
      });
    };

    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(toolbar);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    mo?.observe(toolbar, { childList: true });
    return () => {
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [signature, tx]);

  const collapsedCount = Math.min(overflow.collapsedCount, collapsible.length);
  const modeIndex = mode ? collapsible.indexOf(mode) : -1;
  const modeVisible = modeIndex >= 0 && modeIndex < collapsible.length - collapsedCount;
  const approval = secondary.find((o) => o.category === "approval" || o.category === "mode");
  const summary = secondary.map((o) => `${tx(o.name)}: ${selected(o, valueOf(o))?.name ?? tx("Default")}`).join(" · ");
  return (
    <>
      {inline.map((o) => {
        const secondaryIndex = collapsible.indexOf(o);
        const isSecondary = secondaryIndex >= 0;
        const collapsed = isSecondary && secondaryIndex >= collapsible.length - collapsedCount;
        return (
          <span
            key={o.id}
            data-config-secondary={isSecondary ? "" : undefined}
            className={clsx(styles.configPicker, isSecondary && styles.inlineSetting, collapsed && styles.collapsed)}
          >
            {o === model && combinedModel ? (
              <ModelPicker
                model={o}
                modelValue={valueOf(o)}
                settings={(tuckedEffort ? [tuckedEffort, ...modelConfigs] : modelConfigs)
                  .filter((opt) => opt.values.length > 0)
                  .map((opt) => ({ ...opt, current: valueOf(opt) }))}
                onChange={onChange}
                modelRefresh={modelRefresh}
              />
            ) : o === mode && allowAll ? (
              <ModePicker
                mode={o}
                modeValue={valueOf(o)}
                allowAll={allowAll}
                allowAllValue={valueOf(allowAll)}
                compactDetail={overflow.compactDetail}
                onChange={onChange}
              />
            ) : (
              <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} />
            )}
            {o === model && !combinedModel && modelRefresh?.loadingSettings && <LoadingSettingsChip />}
          </span>
        );
      })}
      {secondary.length > 0 && (
        <div
          ref={menuRef}
          data-config-menu=""
          className={clsx(styles.settingsMenu, collapsedCount > 0 && styles.settingsMenuVisible)}
        >
          <IconButton
            ref={anchor}
            icon={!modeVisible && approval ? modeIcon(valueOf(approval) ?? "") : "settings"}
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

function settingName(option: AgentConfigOption) {
  return option.category === "thought_level"
    ? "Effort Level"
    : isContextOption(option.id)
      ? "Context Size"
      : option.name;
}

function settingValue(option: AgentConfigOption) {
  return selected(option, option.current) ?? option.values[0];
}

function settingsSummary(options: AgentConfigOption[], tx: ReturnType<typeof useTx>, includeInactiveSwitches = false) {
  const format = (o: AgentConfigOption) => {
    const current = settingValue(o);
    const label = current?.name ?? tx("Default");
    const sw = switchValues(o);
    if (sw) {
      const isOn = current?.value === sw.on;
      if (!includeInactiveSwitches && !isOn && options.length > 1) return null;
      return isOn ? tx(o.name) : `${tx(o.name)}: ${label}`;
    }
    return o.category === "thought_level" || o.category === "context_tier" || isContextOption(o.id)
      ? label
      : `${tx(o.name)}: ${label}`;
  };
  const parts = options.map(format).filter((p): p is string => p !== null);
  if (parts.length > 0) return parts.join(" · ");
  return options.map((o) => `${tx(o.name)}: ${settingValue(o)?.name ?? tx("Default")}`).join(" · ");
}

function ModelPicker({
  model,
  modelValue,
  settings,
  onChange,
  modelRefresh,
}: {
  model: AgentConfigOption;
  modelValue: string | null;
  settings: AgentConfigOption[];
  onChange: ChangeOption;
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  // The model chip picks a model; the settings chip next to it holds the model's settings.
  const [open, setOpen] = useState<"models" | "settings" | null>(null);
  const pinnedModels = useAgents((s) => s.pinnedModels);
  const anchor = useRef<HTMLSpanElement>(null);
  const selectedModel = selected(model, modelValue);
  const unavailable = !!modelRefresh && modelValue !== null && !selectedModel;
  const modelName = unavailable
    ? tx`${modelValue} (unavailable)`
    : (selectedModel?.name ?? (modelRefresh ? modelValue : null) ?? tx("Default"));
  const shown = settings.filter((o) => o.values.length > 0);
  const summary = settingsSummary(shown, tx);
  const fullSummary = settingsSummary(shown, tx, true);
  const toggle = (which: "models" | "settings") => {
    if (open === which) return setOpen(null);
    if (which === "models") modelRefresh?.onOpen?.();
    setOpen(which);
  };

  return (
    <span ref={anchor} className={styles.modelControl}>
      <button
        type="button"
        className={styles.chip}
        aria-label={tx(model.name)}
        aria-haspopup="dialog"
        aria-expanded={open === "models"}
        title={`${tx(model.name)}: ${modelName}`}
        onClick={() => toggle("models")}
      >
        <span className={styles.chipValue}>{modelName}</span>
        <Icon name="chevron-down" size={12} className={styles.chipChevron} />
      </button>
      {!unavailable && modelRefresh?.loadingSettings ? (
        <LoadingSettingsChip />
      ) : (
        summary &&
        !unavailable && (
          <button
            type="button"
            className={styles.chip}
            aria-label={tx`Model settings: ${summary}`}
            title={
              fullSummary && fullSummary !== summary
                ? `${tx`Configure ${modelName}…`} (${fullSummary})`
                : tx`Configure ${modelName}…`
            }
            aria-haspopup="dialog"
            aria-expanded={open === "settings"}
            onClick={() => toggle("settings")}
          >
            <span className={styles.chipValue}>{summary}</span>
            <Icon name="chevron-down" size={12} className={styles.chipChevron} />
          </button>
        )
      )}
      <Popup
        open={!!open}
        anchor={anchor}
        onClose={() => setOpen(null)}
        aria-label={tx(open === "settings" ? "Model settings" : "Model")}
        className={styles.modelEffortPopup}
      >
        {open === "settings" ? (
          <ModelSettings settings={shown} onChange={onChange} onDone={() => setOpen(null)} />
        ) : (
          <>
            {unavailable && (
              <p className={styles.catalogError} role="alert">
                <T>Choose another model before starting.</T>
              </p>
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
                  setOpen(null);
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
          </>
        )}
      </Popup>
    </span>
  );
}

/**
 * The current model's settings (effort, context size, fast mode…), each a click away: on/off
 * settings as a switch row, and choice settings consistently as a vertical list so every model
 * shares the same layout, description display, and close behavior. A model with one setting
 * closes on a choice.
 */
function ModelSettings({
  settings,
  onChange,
  onDone,
}: {
  settings: AgentConfigOption[];
  onChange: ChangeOption;
  onDone: () => void;
}) {
  const tx = useTx();
  const only = settings.length === 1;
  return (
    <div className={styles.quickSettings}>
      {settings.map((o) => {
        const label = tx(settingName(o));
        if (switchValues(o)) {
          return (
            <div key={o.id} className={clsx(styles.quickRow, styles.quickToggleRow)}>
              <span className={styles.quickLabel} title={o.description ?? undefined}>
                {label}
              </span>
              <ConfigPicker option={o} value={o.current} onChange={onChange} framed />
            </div>
          );
        }
        const currentValue = settingValue(o)?.value ?? null;
        return (
          <div key={o.id} className={styles.quickRow}>
            <span className={styles.quickLabel} title={o.description ?? undefined}>
              {label}
            </span>
            <SelectListbox
              aria-label={label}
              value={currentValue}
              options={o.values.map((v) => ({ value: v.value, label: v.name, detail: v.description ?? undefined }))}
              onChoose={(v) => {
                if (v !== currentValue) onChange(o.id, v);
                if (only) onDone();
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Where the model's settings chip appears once they arrive. */
function LoadingSettingsChip() {
  const tx = useTx();
  return (
    <span className={clsx(styles.chip, styles.chipLoading)} title={tx("Loading model settings…")}>
      <Spinner size={12} label={tx("Loading model settings…")} />
    </span>
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
    <span className={clsx(styles.costBadge, (category === "high" || category === "very_high") && styles.costBadgeHigh)}>
      {label}
    </span>
  );
}

/** The mode menu, with the agent's two-state permissions or approval option as a switch under it. */
function ModePicker({
  mode,
  modeValue,
  allowAll,
  allowAllValue,
  compactDetail = false,
  onChange,
}: {
  mode: AgentConfigOption;
  modeValue: string | null;
  allowAll: AgentConfigOption;
  allowAllValue: string | null;
  compactDetail?: boolean;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const toggle = modeApprovalSwitch(allowAll)!;
  const current = selected(mode, modeValue);
  const on = allowAllValue === toggle.on;
  const approvalText =
    allowAll.category === "approval"
      ? (selected(allowAll, allowAllValue)?.name ?? (on ? tx("On") : tx("Off")))
      : on
        ? tx("On")
        : tx("Off");
  const summary = `${tx(mode.name)}: ${current?.name ?? tx("Default")} · ${tx(allowAll.name)}: ${approvalText}`;
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
        <Icon name={on ? "unlock" : modeIcon(current?.value ?? "")} size={13} />
        <span className={styles.chipValue}>{current?.name ?? tx("Default")}</span>
        {on && (
          <span className={clsx(styles.chipDetail, compactDetail && styles.compactDetail)} data-chip-detail="">
            {tx(toggle.chipLabel)}
          </span>
        )}
        <Icon name="chevron-down" size={12} className={styles.chipChevron} />
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
          <span title={allowAll.description ?? undefined}>{tx(toggle.label)}</span>
          <Toggle
            checked={on}
            aria-label={tx(toggle.label)}
            onChange={(checked) => onChange(allowAll.id, checked ? toggle.on : toggle.off)}
          />
        </div>
      </Popup>
    </>
  );
}
