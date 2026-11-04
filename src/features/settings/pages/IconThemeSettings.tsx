import type { CSSProperties, ReactNode } from "react";
import type { FileIconThemeOptions as Options } from "@/bindings";
import { Checkbox, Select } from "@/ui";
import { ICON_THEME_LIMITS, validateIconThemeOptions } from "@/platform/iconThemeOptions";
import type { IconThemeDetails, IconThemeSettingItem } from "@/platform/themes";
import { ColorSwatches, NumberInput, Row, Section, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
import styles from "./Behavior.module.css";

type Flag = "hideFiles" | "hideFolders" | "hideUiIcons" | "hidePsiIcons" | "hollowFolders";
type Colour = "accent" | "monochrome";
type Amount = keyof typeof ICON_THEME_LIMITS;

const UNITS: Partial<Record<Amount, string>> = { opacity: "%", iconSize: "px", rowHeight: "px" };

interface ItemProps {
  item: IconThemeSettingItem;
  details: IconThemeDetails;
  options: Options;
  set: (patch: Partial<Options>) => void;
}

function Hint({ text }: { text?: string | null }) {
  return text ? <div className={styles.iconHint}>{text}</div> : null;
}

function Line({ children }: { children: ReactNode }) {
  return <div className={styles.fontRow}>{children}</div>;
}

function FlagItem({ item, options, set, flag }: ItemProps & { flag: Flag }) {
  const value = !!options[flag];
  return (
    <Toggle
      label={item.label ?? ""}
      hint={item.hint ? <span>{item.hint}</span> : undefined}
      checked={item.invert ? !value : value}
      onChange={(on) => set({ [flag]: item.invert ? !on : on })}
    />
  );
}

function GroupsItem({ item, details, options, set }: ItemProps) {
  const style = { "--icon-pack-columns": item.columns ?? 1 } as CSSProperties;
  return (
    <>
      {item.label && <div className={styles.iconLabel}>{item.label}</div>}
      <div className={styles.iconPacks} style={style}>
        {details.groups.map((g) => (
          <Checkbox
            key={g.id}
            label={g.name}
            checked={options.groups?.[g.id] ?? g.enabled}
            onChange={(on) => set({ groups: { ...options.groups, [g.id]: on } })}
          />
        ))}
      </div>
      <Hint text={item.hint} />
    </>
  );
}

function ChoiceItem({ item, details, options, set }: ItemProps) {
  const choice = details.choices.find((c) => c.id === item.choice);
  if (!choice) return null;
  return (
    <Row label={item.label ?? choice.name} hint={item.hint ? <span>{item.hint}</span> : undefined}>
      <Select
        aria-label={item.label ?? choice.name}
        value={options.choices?.[choice.id] ?? choice.default}
        options={choice.options.map((o) => ({ value: o.id, label: o.name }))}
        onChange={(value) => set({ choices: { ...options.choices, [choice.id]: value } })}
      />
    </Row>
  );
}

function ColourItem({ item, options, set, colour }: ItemProps & { colour: Colour }) {
  const label = item.label ?? "";
  const value = options[colour];
  const fallback = String(item.default ?? "");
  return (
    <>
      <Line>
        <Checkbox label={label} checked={!!value} onChange={(on) => set({ [colour]: on ? fallback : null })} />
        {value && (
          <ColorSwatches
            value={value}
            presets={[{ value: fallback, label: "Default" }]}
            onChange={(v) => set({ [colour]: v })}
            aria-label={label}
          />
        )}
      </Line>
      <Hint text={item.hint} />
    </>
  );
}

function AmountItem({ item, options, set, amount }: ItemProps & { amount: Amount }) {
  const label = item.label ?? "";
  const value = options[amount];
  const fallback = Number(item.default ?? ICON_THEME_LIMITS[amount].min);
  return (
    <>
      <Line>
        <Checkbox label={label} checked={value != null} onChange={(on) => set({ [amount]: on ? fallback : null })} />
        {value != null && (
          <NumberInput
            aria-label={label}
            value={value}
            {...ICON_THEME_LIMITS[amount]}
            integer
            unit={UNITS[amount]}
            onChange={(v) => set({ [amount]: v })}
          />
        )}
      </Line>
      <Hint text={item.hint} />
    </>
  );
}

function Item(props: ItemProps) {
  const { option } = props.item;
  switch (option) {
    case "hideFiles":
    case "hideFolders":
    case "hideUiIcons":
    case "hidePsiIcons":
    case "hollowFolders":
      return <FlagItem {...props} flag={option} />;
    case "groups":
      return <GroupsItem {...props} />;
    case "choice":
      return <ChoiceItem {...props} />;
    case "accent":
    case "monochrome":
      return <ColourItem {...props} colour={option} />;
    case "saturation":
    case "opacity":
    case "iconSize":
    case "rowHeight":
      return <AmountItem {...props} amount={option} />;
  }
}

export function IconThemeSettings({ themeKey, details }: { themeKey: string; details: IconThemeDetails }) {
  const [all, setAll] = useSetting<Record<string, Options> | undefined>("appearance.fileIconThemeOptions");
  const options = validateIconThemeOptions(all?.[themeKey]);
  const set = (patch: Partial<Options>) => setAll({ ...all, [themeKey]: { ...options, ...patch } });
  return details.settings.map((section, i) => (
    <Section key={i} title={section.title}>
      {section.items.map((item, j) => (
        <Item key={j} item={item} details={details} options={options} set={set} />
      ))}
    </Section>
  ));
}
