/**
 * Model/mode/effort/approval controls in the composer's bottom row,
 * styled after JetBrains IntelliJ AIR's 2-pill selector UX:
 * - Pill 1: `<Model Name> <Effort Label>` -> opens the Model & Effort popup with
 *   a cascading Model selector and a discrete N-step Effort pill slider.
 * - Pill 2: `<Mode Name> [Allow All]` -> opens the Mode & Allow All popup.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentConfigOption } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Icon, IconButton, Popup, Select, Toggle } from "@/ui";
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

function toggleValues(option: AgentConfigOption): { on: string; off: string } | null {
  const find = (kind: "on" | "off") =>
    option.values.find((v) => (kind === "on" ? /^(on|true)$/i.test(v.value) : /^(off|false)$/i.test(v.value)))?.value;
  const on = find("on");
  const off = find("off");
  return on && off ? { on, off } : null;
}

/** Human-readable effort label matching JetBrains IntelliJ AIR (`AgentReasoningEffortPresentationKt`). */
export function effortLabel(value: string, fallbackName?: string): string {
  switch (value.toLowerCase()) {
    case "auto":
      return "Default";
    case "none":
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    case "ultra":
      return "Ultra";
    default:
      return fallbackName || value;
  }
}

function isExpensiveEffort(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "max" || v === "ultra";
}

function resolveThoughtState(
  rawThought: AgentConfigOption | null,
  values?: Record<string, string>,
): {
  thoughtOption: AgentConfigOption | null;
  thoughtValue: string | null;
} {
  if (rawThought && rawThought.values.length > 0) {
    const candidate = values?.[rawThought.id] ?? rawThought.current ?? rawThought.values[0]?.value ?? null;
    const valid = rawThought.values.some((v) => v.value === candidate)
      ? candidate
      : (rawThought.current ?? rawThought.values[0]?.value ?? null);
    return {
      thoughtOption: rawThought,
      thoughtValue: valid,
    };
  }
  return { thoughtOption: null, thoughtValue: null };
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

  const model = options.find((o) => o.category === "model") ?? null;
  const rawThought = options.find((o) => o.category === "thought_level") ?? null;
  const mode = options.find((o) => o.category === "mode") ?? null;
  const permissions = options.find((o) => o.category === "permissions" && toggleValues(o)) ?? null;

  const [hadThought, setHadThought] = useState(false);
  if (rawThought && rawThought.values.length > 0 && !hadThought) {
    setHadThought(true);
  }

  const selectedModelId = model ? (values?.[model.id] ?? model.current ?? model.values[0]?.value ?? null) : null;
  const { thoughtOption, thoughtValue } = resolveThoughtState(rawThought, values);
  const effortSupported = !!(thoughtOption || hadThought || permissions);

  const permissionValue = permissions ? (values?.[permissions.id] ?? permissions.current ?? null) : null;
  const mergedModePermissions = !!(mode && permissions);
  const mergedModelEffort = !!(model && (thoughtOption || effortSupported));

  const shown = options.filter((o) => {
    if (mergedModePermissions && o.category === "permissions") return false;
    if (mergedModelEffort && o.category === "thought_level") return false;
    return true;
  });

  // Extra options beyond the primary Model+Effort and Mode+AllowAll pills (e.g. Cursor approvals).
  const extraSecondary = shown.filter(
    (o) =>
      o.category !== "model" &&
      !(mergedModePermissions && o.category === "mode") &&
      !(mergedModelEffort && o.category === "thought_level"),
  );
  const summary = extraSecondary
    .map((o) => {
      const value = values?.[o.id] ?? o.current;
      return `${tx(o.name)}: ${o.values.find((v) => v.value === value)?.name ?? tx("Default")}`;
    })
    .join(" · ");

  return (
    <>
      {shown.map((o) => {
        if (o.category === "model" && mergedModelEffort) {
          return (
            <span key={o.id} className={styles.configPicker}>
              <ModelEffortPicker
                modelOption={o}
                modelValue={selectedModelId}
                thoughtOption={thoughtOption}
                thoughtValue={thoughtValue}
                effortSupported={effortSupported}
                onChange={onChange}
              />
            </span>
          );
        }
        return (
          <span
            key={o.id}
            className={clsx(
              styles.configPicker,
              o.category !== "model" && !(mergedModePermissions && o.category === "mode") && styles.inlineSetting,
            )}
          >
            {o.category === "model" && <Icon name="toolwindow-agents" size={14} className={styles.modelBadgeIcon} />}
            <ConfigPicker
              option={o}
              value={values?.[o.id] ?? o.current ?? null}
              onChange={onChange}
              permissionsOption={o.category === "mode" ? permissions : null}
              permissionsValue={permissionValue}
            />
          </span>
        );
      })}
      {extraSecondary.length > 0 && (
        <div className={styles.settingsMenu}>
          <IconButton
            ref={anchor}
            icon="chevron-down"
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
            {extraSecondary.map((o) => (
              <div key={o.id} className={styles.settingsRow}>
                <span className={styles.settingsLabel}>{tx(o.name)}</span>
                <ConfigPicker
                  option={o}
                  value={values?.[o.id] ?? o.current ?? null}
                  onChange={onChange}
                  framed
                  permissionsOption={o.category === "mode" ? permissions : null}
                  permissionsValue={permissionValue}
                />
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
  permissionsOption = null,
  permissionsValue = null,
}: {
  option: AgentConfigOption;
  value: string | null;
  onChange: (option: string, value: string) => void;
  framed?: boolean;
  permissionsOption?: AgentConfigOption | null;
  permissionsValue?: string | null;
}) {
  const tx = useTx();
  if (option.category === "mode" && permissionsOption) {
    return (
      <ModePicker
        option={option}
        value={value}
        onChange={onChange}
        framed={framed}
        permissionsOption={permissionsOption}
        permissionsValue={permissionsValue}
      />
    );
  }
  const toggle = option.category === "permissions" ? toggleValues(option) : null;
  if (toggle) {
    return (
      <Toggle
        checked={value === toggle.on}
        aria-label={tx(option.name)}
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
                {current ? effortLabel(current.value, current.label) : tx("Default")}
              </span>
            )
          : undefined
      }
    />
  );
}

function ModelEffortPicker({
  modelOption,
  modelValue,
  thoughtOption,
  thoughtValue,
  effortSupported,
  onChange,
}: {
  modelOption: AgentConfigOption;
  modelValue: string | null;
  thoughtOption: AgentConfigOption | null;
  thoughtValue: string | null;
  effortSupported: boolean;
  onChange: (option: string, value: string) => void;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const modelRowRef = useRef<HTMLButtonElement>(null);

  const currentModel = modelOption.values.find((v) => v.value === modelValue) ?? modelOption.values[0] ?? null;
  const currentEffort = thoughtOption?.values.find((v) => v.value === thoughtValue) ?? thoughtOption?.values[0] ?? null;
  const currentEffortText = currentEffort ? tx(effortLabel(currentEffort.value, currentEffort.name)) : null;

  // Support ⇧⌘M / Ctrl+Shift+M to toggle the Model & Effort popup, matching IntelliJ AIR.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setOpen((v) => {
          if (v) setModelMenuOpen(false);
          return !v;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const selectModel = (nextModelId: string) => {
    onChange(modelOption.id, nextModelId);
    setModelMenuOpen(false);
  };

  return (
    <div className={styles.airChipWrap}>
      <button
        ref={anchor}
        type="button"
        className={clsx(styles.airChip, open && styles.airChipOpen)}
        aria-label={tx(modelOption.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() =>
          setOpen((v) => {
            if (v) setModelMenuOpen(false);
            return !v;
          })
        }
      >
        <Icon name="toolwindow-agents" size={14} className={styles.modelBadgeIcon} />
        <span className={styles.airChipPrimary}>{currentModel?.name ?? tx("Default")}</span>
        {currentEffortText && <span className={styles.airChipSecondary}>{currentEffortText}</span>}
      </button>

      {!open && (
        <div className={styles.airTooltip} role="tooltip">
          <div className={styles.airTooltipGrid}>
            <span className={styles.airTooltipKey}>{tx("Model")}</span>
            <span className={styles.airTooltipVal}>{currentModel?.name ?? tx("Default")}</span>
            {currentEffortText && (
              <>
                <span className={styles.airTooltipKey}>{tx("Effort")}</span>
                <span className={styles.airTooltipVal}>{currentEffortText}</span>
              </>
            )}
          </div>
          <div className={styles.airTooltipFooter}>
            <span>{tx("Model & effort settings")}</span>
            <kbd className={styles.airTooltipShortcut}>⇧⌘M</kbd>
          </div>
        </div>
      )}

      <Popup
        open={open}
        anchor={anchor}
        placement="top-start"
        onClose={() => {
          setOpen(false);
          setModelMenuOpen(false);
        }}
        aria-label={tx("Model & effort settings")}
        className={styles.modelEffortPopup}
      >
        <button
          ref={modelRowRef}
          type="button"
          className={clsx(styles.modelEffortDropdownRow, modelMenuOpen && styles.modelEffortDropdownRowActive)}
          aria-label={tx("Select model")}
          aria-haspopup="listbox"
          aria-expanded={modelMenuOpen}
          onClick={() => setModelMenuOpen((v) => !v)}
        >
          <span className={styles.modelEffortLabel}>{tx("Model")}</span>
          <span className={styles.modelEffortCurrent}>
            <span className={styles.modelEffortCurrentName}>{currentModel?.name ?? tx("Default")}</span>
            <Icon name="chevron-right" size={12} className={styles.modelEffortChevron} />
          </span>
        </button>

        <Popup
          open={modelMenuOpen}
          anchor={modelRowRef}
          placement="right-start"
          offset={6}
          onClose={() => setModelMenuOpen(false)}
          aria-label={tx(modelOption.name)}
          className={styles.modelSubmenuPopup}
        >
          <div className={styles.modelSubmenuList} role="listbox" aria-label={tx(modelOption.name)}>
            {modelOption.values.map((v) => {
              const selected = v.value === (modelValue ?? modelOption.current);
              return (
                <button
                  key={v.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={clsx(styles.modelSubmenuItem, selected && styles.modelSubmenuItemActive)}
                  onClick={() => selectModel(v.value)}
                >
                  <span className={styles.modelSubmenuName}>{v.name}</span>
                  <span className={styles.modelSubmenuRight}>
                    {v.description && <span className={styles.modelSubmenuDetail}>{v.description}</span>}
                    <span className={styles.modelSubmenuCheck}>{selected && <Icon name="check" size={12} />}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Popup>

        {(thoughtOption || effortSupported) && (
          <div className={styles.effortSection}>
            <div className={styles.effortHeaderRow}>
              <span className={styles.modelEffortLabel}>{tx("Effort")}</span>
              <span className={styles.effortValueLabel}>
                {thoughtOption && currentEffortText ? currentEffortText : tx("Not supported")}
              </span>
            </div>
            {thoughtOption && thoughtOption.values.length > 0 && (
              <EffortSlider
                option={thoughtOption}
                value={currentEffort?.value ?? thoughtOption.values[0]!.value}
                onChange={(val) => onChange(thoughtOption.id, val)}
              />
            )}
          </div>
        )}
      </Popup>
    </div>
  );
}

function EffortSlider({
  option,
  value,
  onChange,
}: {
  option: AgentConfigOption;
  value: string;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const trackRef = useRef<HTMLDivElement>(null);
  const steps = option.values;
  const count = steps.length;
  const rawIndex = steps.findIndex((v) => v.value === value);
  const selectedIndex = rawIndex >= 0 ? rawIndex : 0;
  const selectedStep = steps[selectedIndex]!;
  const expensive = isExpensiveEffort(selectedStep.value);
  const ratio = count > 1 ? selectedIndex / (count - 1) : 1;

  const pickAtClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || count <= 1) return;
    const rect = el.getBoundingClientRect();
    const inset = 11.5;
    const usable = Math.max(1, rect.width - inset * 2);
    const clamped = Math.min(1, Math.max(0, (clientX - (rect.left + inset)) / usable));
    const idx = Math.round(clamped * (count - 1));
    const target = steps[idx];
    if (target && target.value !== value) {
      onChange(target.value);
    }
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      tabIndex={0}
      aria-label={tx(option.name)}
      title={selectedStep.description ?? undefined}
      className={styles.effortSliderTrack}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        pickAtClientX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) pickAtClientX(e.clientX);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
          e.preventDefault();
          const prev = steps[Math.max(0, selectedIndex - 1)];
          if (prev && prev.value !== value) onChange(prev.value);
        } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
          e.preventDefault();
          const next = steps[Math.min(count - 1, selectedIndex + 1)];
          if (next && next.value !== value) onChange(next.value);
        } else if (e.key === "Home") {
          e.preventDefault();
          const first = steps[0];
          if (first && first.value !== value) onChange(first.value);
        } else if (e.key === "End") {
          e.preventDefault();
          const last = steps[count - 1];
          if (last && last.value !== value) onChange(last.value);
        }
      }}
    >
      <div
        className={clsx(styles.effortSliderFill, expensive && styles.effortSliderFillExpensive)}
        style={{
          width: `calc(23px + (100% - 23px) * ${ratio})`,
        }}
      />
      {steps.map((step, idx) => {
        const stepRatio = count > 1 ? idx / (count - 1) : 0.5;
        const active = idx === selectedIndex;
        const covered = idx < selectedIndex;
        return (
          <button
            key={step.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={-1}
            aria-label={tx(effortLabel(step.value, step.name))}
            title={step.description ?? tx(effortLabel(step.value, step.name))}
            className={clsx(
              styles.effortSliderStep,
              active && styles.effortSliderStepActive,
              covered && styles.effortSliderStepCovered,
            )}
            style={{
              left: `calc(11.5px + (100% - 23px) * ${stepRatio})`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (step.value !== value) onChange(step.value);
            }}
          />
        );
      })}
      <div
        className={styles.effortSliderThumb}
        style={{
          left: `calc(11.5px + (100% - 23px) * ${ratio})`,
        }}
      />
    </div>
  );
}

function modeDescription(value: string): string | null {
  const m =
    value
      .toLowerCase()
      .split(/[#/]/)
      .at(-1)
      ?.replace(/[^a-z]/g, "") ?? "";
  if (m.includes("plan")) return "Plan mode for creating and executing multi-step plans";
  if (m.includes("autopilot")) return "Autopilot mode for autonomous execution with fewer interruptions";
  if (m.includes("agent")) return "Agent mode for coding and tool execution";
  return null;
}

function ModePicker({
  option,
  value,
  onChange,
  framed,
  permissionsOption,
  permissionsValue,
}: {
  option: AgentConfigOption;
  value: string | null;
  onChange: (option: string, value: string) => void;
  framed: boolean;
  permissionsOption: AgentConfigOption;
  permissionsValue: string | null;
}) {
  const tx = useTx();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const current = option.values.find((v) => v.value === value) ?? option.values[0] ?? null;
  const permissions = useMemo(() => toggleValues(permissionsOption), [permissionsOption]);
  const allowAllOn = !!(permissions && permissionsValue === permissions.on);

  return (
    <div className={styles.airChipWrap}>
      <button
        ref={anchor}
        type="button"
        className={clsx(styles.airChip, framed && styles.modeTriggerFramed, open && styles.airChipOpen)}
        aria-label={tx(option.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.airChipPrimary}>{current?.name ?? tx("Default")}</span>
        {allowAllOn && <span className={styles.airChipSecondary}>{tx(permissionsOption.name)}</span>}
      </button>

      {!open && !framed && (
        <div className={styles.airTooltip} role="tooltip">
          <div className={styles.airTooltipGrid}>
            <span className={styles.airTooltipKey}>{tx(option.name)}</span>
            <span className={styles.airTooltipVal}>{current?.name ?? tx("Default")}</span>
            {permissions && (
              <>
                <span className={styles.airTooltipKey}>{tx(permissionsOption.name)}</span>
                <span className={styles.airTooltipVal}>{allowAllOn ? tx("On") : tx("Off")}</span>
              </>
            )}
          </div>
        </div>
      )}

      <Popup
        open={open}
        anchor={anchor}
        placement="top-start"
        onClose={() => setOpen(false)}
        aria-label={tx(option.name)}
        className={styles.modePopup}
      >
        <div className={styles.modePopupHeader}>{tx(option.name)}</div>
        <div className={styles.modePopupList} role="listbox" aria-label={tx(option.name)}>
          {option.values.map((v) => {
            const selected = v.value === (value ?? option.current);
            const description = v.description ?? modeDescription(v.value);
            return (
              <button
                key={v.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={clsx(styles.modePopupItem, selected && styles.modePopupItemActive)}
                title={description ?? undefined}
                onClick={() => {
                  onChange(option.id, v.value);
                  setOpen(false);
                }}
              >
                <span>{tx(v.name)}</span>
                {selected && <Icon name="check" size={12} />}
              </button>
            );
          })}
        </div>
        {permissions && (
          <div className={styles.modePopupFooter}>
            <span className={styles.modePopupFooterLabel}>{tx(permissionsOption.name)}</span>
            <Toggle
              checked={allowAllOn}
              aria-label={tx(permissionsOption.name)}
              onChange={(checked) => onChange(permissionsOption.id, checked ? permissions.on : permissions.off)}
            />
          </div>
        )}
      </Popup>
    </div>
  );
}
