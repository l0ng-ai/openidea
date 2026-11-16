/**
 * Model, mode, approvals and thinking-effort controls for a composer's bottom row.
 * With a model plus effort, model-config or cost metadata, one button shows the active
 * summary and opens a two-page popup: a searchable model list (with pinned models and
 * per-row configure buttons) and a per-model configuration view with segmented Effort
 * Level, optional segmented Context Size, Reset / Pin actions, and a cost badge.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import type { AgentConfigOption, AgentModelPricing } from "@/bindings";
import { tx as rawTx, useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, Select, T, Toggle } from "@/ui";
import { SelectListbox, type SelectOption } from "@/ui/Select";
import { formatCreditRate, isContextOption, mainOptions, modelConfigOptions, modeIcon } from "./composerModel";
import { togglePinnedModel, useAgents } from "./store";
import styles from "./Composer.module.css";

export function configPickerOptions(option: AgentConfigOption, pinned: readonly string[] = []): SelectOption[] {
  if (option.category !== "model") {
    return option.values.map((v) => ({ value: v.value, label: v.name, detail: v.description ?? undefined }));
  }
  const pinnedSet = new Set(pinned);
  const buildItem = (v: AgentConfigOption["values"][number]): { provider: string; opt: SelectOption } => {
    const slash = v.value.indexOf("/");
    const provider = slash >= 0 ? v.value.slice(0, slash) : "";
    const path = slash >= 0 ? v.value.slice(slash + 1) : "";
    const label = path ? path.slice(path.lastIndexOf("/") + 1) : v.name || v.value;
    const mult = v.usageMultiplier && !v.description?.startsWith(v.usageMultiplier) ? v.usageMultiplier : undefined;
    const parts = [path || undefined, mult, v.description ?? undefined].filter((p): p is string => !!p);
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
  refreshing: boolean;
  retryAtMs: number | null;
  error: string | null;
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
  /** Only New Task supplies catalog discovery; session pickers retain their own settings. */
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = mainOptions(config);
  if (modelRefresh && !options.some((o) => o.category === "model"))
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
  const combinedModel = model && (modelRefresh || effort || modelConfigs.length > 0 || hasCostMeta);
  const tuckedModelConfig = new Set(modelConfigs.map((o) => o.id));
  const mode = options.find((o) => o.category === "mode");
  const allowAll = mode && options.find((o) => switchValues(o));
  const inline = options.filter(
    (o) => o !== effort && o !== allowAll && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  // The compact menu holds everything but the model button (effort + model parameters).
  const secondary = options.filter(
    (o) => o.category !== "model" && o !== effort && !(combinedModel && tuckedModelConfig.has(o.id)),
  );
  const approval = secondary.find((o) => o.category === "approval" || o.category === "mode");
  const summary = secondary.map((o) => `${tx(o.name)}: ${selected(o, valueOf(o))?.name ?? tx("Default")}`).join(" · ");
  return (
    <>
      {inline.map((o) => (
        <span key={o.id} className={clsx(styles.configPicker, o.category !== "model" && styles.inlineSetting)}>
          {o === model && combinedModel ? (
            <ModelEffortPicker
              model={o}
              modelValue={valueOf(o)}
              effort={effort}
              effortValue={effort ? valueOf(effort) : null}
              modelConfigs={modelConfigs}
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

/** Two-page model & per-model configuration picker (searchable list + detail page). */
function ModelEffortPicker({
  model,
  modelValue,
  effort,
  effortValue,
  modelConfigs,
  valueOf,
  onChange,
  modelRefresh,
}: {
  model: AgentConfigOption;
  modelValue: string | null;
  effort?: AgentConfigOption;
  effortValue: string | null;
  modelConfigs: AgentConfigOption[];
  valueOf: (o: AgentConfigOption) => string | null;
  onChange: (option: string, value: string) => void;
  modelRefresh?: ModelRefresh;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"list" | "detail">("list");
  const pinnedModels = useAgents((s) => s.pinnedModels);
  const anchor = useRef<HTMLButtonElement>(null);
  const selectedModel = selected(model, modelValue);
  const unavailable = modelRefresh && modelValue !== null && !selectedModel;
  const modelName = unavailable ? tx`${modelValue} (unavailable)` : (selectedModel?.name ?? tx("Default"));
  const effortName = effort ? (selected(effort, effortValue)?.name ?? tx("Default")) : null;

  const contextOption = modelConfigs.find((o) => isContextOption(o.id) && o.values.length > 0);
  const contextValue = contextOption ? valueOf(contextOption) : null;
  const contextLabel = contextOption ? (selected(contextOption, contextValue)?.name ?? null) : null;
  const otherModelConfigs = modelConfigs.filter((o) => o !== contextOption);

  const chipBadges = [effortName, contextLabel].filter((x): x is string => !!x);
  const chipBadgeText = chipBadges.join(" · ");

  const otherSummary = otherModelConfigs
    .map((o) => {
      const current = selected(o, valueOf(o));
      return current ? `${tx(o.name)}: ${current.name}` : null;
    })
    .filter(Boolean)
    .join(" · ");
  const summary = [
    effortName ? `${tx(effort!.name)}: ${effortName}` : null,
    contextLabel ? `${tx("Context Size")}: ${contextLabel}` : null,
    otherSummary,
  ]
    .filter(Boolean)
    .join(" · ");

  const canConfigureActive = !!(
    effort ||
    contextOption ||
    otherModelConfigs.length > 0 ||
    selectedModel?.costCategory ||
    selectedModel?.usageMultiplier ||
    selectedModel?.pricing
  );

  const closePopup = () => {
    setOpen(false);
    setPage("list");
  };

  const openDetailFor = (targetModelValue: string) => {
    if (targetModelValue !== modelValue) {
      onChange(model.id, targetModelValue);
    }
    setPage("detail");
  };

  const sizerCandidates =
    effort && !contextLabel
      ? [...new Set([chipBadgeText, ...effort.values.map((v) => v.name)])]
      : chipBadgeText
        ? [chipBadgeText]
        : [];

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
          setOpen((prev) => {
            if (prev) setPage("list");
            return !prev;
          });
        }}
      >
        <span className={styles.chipValue}>{modelName}</span>
        {chipBadgeText && (
          <span className={styles.chipDetail}>
            {sizerCandidates.map((text) => (
              <span
                key={text}
                className={text === chipBadgeText ? undefined : styles.chipSizer}
                aria-hidden={text !== chipBadgeText}
              >
                {text}
              </span>
            ))}
          </span>
        )}
        <Icon name="chevron-down" size={14} className={styles.chipChevron} />
      </button>
      <Popup
        open={open}
        anchor={anchor}
        onClose={closePopup}
        aria-label={tx("Model & effort settings")}
        className={styles.modelEffortPopup}
      >
        {page === "detail" && selectedModel ? (
          <ModelDetailView
            modelEntry={selectedModel}
            effort={effort}
            effortValue={effortValue}
            contextOption={contextOption}
            contextValue={contextValue}
            otherModelConfigs={otherModelConfigs}
            valueOf={valueOf}
            pinned={pinnedModels.includes(selectedModel.value)}
            onBack={() => setPage("list")}
            onTogglePin={() => togglePinnedModel(selectedModel.value)}
            onChange={onChange}
          />
        ) : (
          <>
            {unavailable && (
              <p className={styles.catalogError} role="alert">
                <T>Choose another model before starting.</T>
              </p>
            )}
            {canConfigureActive && selectedModel && (
              <button
                type="button"
                className={styles.activeModelBar}
                aria-label={tx("Configure model")}
                onClick={() => setPage("detail")}
              >
                <span className={styles.activeModelName}>{modelName}</span>
                <CostBadge category={selectedModel.costCategory} />
                {chipBadgeText && <span className={styles.activeModelMeta}>{chipBadgeText}</span>}
                <span className={styles.activeModelGear}>
                  <Icon name="sliders" size={13} />
                  <Icon name="chevron-right" size={12} />
                </span>
              </button>
            )}
            {otherModelConfigs.map((o) => (
              <div key={o.id} className={styles.modeFooter}>
                <span title={o.description ?? undefined}>{tx(o.name)}</span>
                <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} framed />
              </div>
            ))}
            {model.values.length > 0 || !modelRefresh ? (
              <SelectListbox
                aria-label={tx(model.name)}
                value={modelValue}
                options={configPickerOptions(model, pinnedModels)}
                searchable
                listClassName={styles.modelList}
                onChoose={(v) => onChange(model.id, v)}
                renderAction={(opt) => {
                  const raw = model.values.find((v) => v.value === opt.value);
                  if (!raw) return null;
                  const showRowBadge = !!raw.costCategory && !raw.description;
                  return (
                    <>
                      {showRowBadge && <CostBadge category={raw.costCategory} />}
                      <button
                        type="button"
                        className={styles.modelRowConfigure}
                        aria-label={rawTx`Configure ${opt.label}`}
                        title={rawTx`Configure ${opt.label}`}
                        onClick={() => openDetailFor(opt.value)}
                      >
                        <Icon name="sliders" size={12} />
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

/** Page 2: per-model configuration view (segmented Effort, optional Context Size, Reset, Pin, and cost info). */
function ModelDetailView({
  modelEntry,
  effort,
  effortValue,
  contextOption,
  contextValue,
  otherModelConfigs,
  valueOf,
  pinned,
  onBack,
  onTogglePin,
  onChange,
}: {
  modelEntry: AgentConfigOption["values"][number];
  effort?: AgentConfigOption;
  effortValue: string | null;
  contextOption?: AgentConfigOption;
  contextValue: string | null;
  otherModelConfigs: AgentConfigOption[];
  valueOf: (o: AgentConfigOption) => string | null;
  pinned: boolean;
  onBack: () => void;
  onTogglePin: () => void;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [pricingOpen, setPricingOpen] = useState(true);

  const defaultEffort = effort ? (effort.defaultValue ?? effort.current) : null;
  const defaultContext = contextOption ? (contextOption.defaultValue ?? contextOption.current) : null;
  const effortAtDefault = !effort || !defaultEffort || effortValue === defaultEffort;
  const contextAtDefault = !contextOption || !defaultContext || contextValue === defaultContext;
  const othersAtDefault = otherModelConfigs.every((o) => {
    const def = o.defaultValue ?? o.current;
    return !def || valueOf(o) === def;
  });
  const atDefaults = effortAtDefault && contextAtDefault && othersAtDefault;

  const handleReset = () => {
    if (effort && defaultEffort && effortValue !== defaultEffort) {
      onChange(effort.id, defaultEffort);
    }
    if (contextOption && defaultContext && contextValue !== defaultContext) {
      onChange(contextOption.id, defaultContext);
    }
    for (const o of otherModelConfigs) {
      const def = o.defaultValue ?? o.current;
      if (def && valueOf(o) !== def) {
        onChange(o.id, def);
      }
    }
  };

  const compactEffort = (effort?.values.length ?? 0) >= 5;
  const hasCostCard = !!(modelEntry.costCategory || modelEntry.usageMultiplier);

  return (
    <div className={styles.modelDetail}>
      <div className={styles.modelDetailHeader}>
        <IconButton
          icon="arrow-left"
          size="small"
          aria-label={tx("Back to models")}
          title={tx("Back to models")}
          onClick={onBack}
        />
        <span className={styles.modelDetailTitle} title={modelEntry.name}>
          {modelEntry.name}
        </span>
        <div className={styles.modelDetailActions}>
          <IconButton
            icon="undo"
            size="small"
            disabled={atDefaults}
            aria-label={tx("Reset to defaults")}
            title={tx("Reset to defaults")}
            onClick={handleReset}
          />
          <IconButton
            icon="pin"
            size="small"
            aria-label={pinned ? tx("Unpin model") : tx("Pin model")}
            title={pinned ? tx("Unpin model") : tx("Pin model")}
            aria-pressed={pinned}
            className={clsx(pinned && styles.pinnedButton)}
            onClick={onTogglePin}
          />
        </div>
      </div>

      {effort && effort.values.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>
            <T>Effort Level</T>
          </div>
          <SegmentedControl
            ariaLabel={tx(effort.name)}
            options={effort.values.map((v) => ({
              value: v.value,
              label: compactEffort && v.value === "xhigh" ? tx("XHigh") : v.name,
              description: v.description ?? undefined,
            }))}
            value={effortValue ?? effort.values[0]!.value}
            onChange={(v) => onChange(effort.id, v)}
          />
        </div>
      )}

      {contextOption && contextOption.values.length > 0 && (
        <div className={styles.detailSection}>
          <div className={styles.detailSectionLabel}>
            <T>Context Size</T>
          </div>
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
        <div key={o.id} className={styles.detailRow}>
          <span className={styles.detailSectionLabel} title={o.description ?? undefined}>
            {tx(o.name)}
          </span>
          <ConfigPicker option={o} value={valueOf(o)} onChange={onChange} framed />
        </div>
      ))}

      {modelEntry.pricing ? (
        <PricingDetailsCard
          pricing={modelEntry.pricing}
          activeTier={contextValue}
          open={pricingOpen}
          onToggle={() => setPricingOpen((v) => !v)}
        />
      ) : (
        hasCostCard && (
          <div className={styles.costCard}>
            <div className={styles.costCardHeader}>
              <span className={styles.costCardTitle}>
                <T>Pricing details</T>
              </span>
              <CostBadge category={modelEntry.costCategory} />
            </div>
            {modelEntry.usageMultiplier && (
              <div className={styles.costCardRow}>
                <span>
                  <T>Multiplier</T>
                </span>
                <span className={styles.costCardValue}>{modelEntry.usageMultiplier}</span>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** Collapsible per-tier token pricing breakdown card (`Credits per 1M tokens`). */
function PricingDetailsCard({
  pricing,
  activeTier,
  open,
  onToggle,
}: {
  pricing: AgentModelPricing;
  activeTier: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const tiers = pricing.tiers ?? {};
  const tierData =
    (activeTier ? tiers[activeTier] : undefined) ?? tiers["default"] ?? tiers["long_context"] ?? undefined;
  const hasRates = tierData && (tierData.input != null || tierData.output != null);
  if (!hasRates && pricing.multiplier == null && !pricing.costTier) return null;

  return (
    <div className={styles.pricingCard}>
      <button type="button" className={styles.pricingHeader} aria-expanded={open} onClick={onToggle}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className={styles.pricingChevron} />
        <span className={styles.pricingTitle}>
          <T>Pricing details</T>
        </span>
        {pricing.costTier ? (
          <CostBadge category={pricing.costTier} />
        ) : (
          pricing.multiplier != null && (
            <span className={styles.costBadge}>{`${formatCreditRate(pricing.multiplier)}x`}</span>
          )
        )}
      </button>
      {open && (
        <div className={styles.pricingBody}>
          {hasRates && tierData ? (
            <>
              <div className={styles.pricingSubhead}>
                <T>Credits per 1M tokens</T>
              </div>
              <div className={styles.costCardRow}>
                <span>
                  <T>Input</T>
                </span>
                <span className={styles.costCardValue}>{formatCreditRate(tierData.input)}</span>
              </div>
              <div className={styles.costCardRow}>
                <span>
                  <T>Output</T>
                </span>
                <span className={styles.costCardValue}>{formatCreditRate(tierData.output)}</span>
              </div>
              {tierData.cacheRead != null && (
                <div className={styles.costCardRow}>
                  <span>
                    <T>Cache Read</T>
                  </span>
                  <span className={styles.costCardValue}>{formatCreditRate(tierData.cacheRead)}</span>
                </div>
              )}
              {tierData.cacheWrite != null && (
                <div className={styles.costCardRow}>
                  <span>
                    <T>Cache Write</T>
                  </span>
                  <span className={styles.costCardValue}>{formatCreditRate(tierData.cacheWrite)}</span>
                </div>
              )}
            </>
          ) : (
            pricing.multiplier != null && (
              <div className={styles.costCardRow}>
                <span>
                  <T>Multiplier</T>
                </span>
                <span className={styles.costCardValue}>{`${formatCreditRate(pricing.multiplier)}x`}</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** Accessible segmented pill selector (`role="radiogroup"`) with Left/Right arrow navigation. */
function SegmentedControl({
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
