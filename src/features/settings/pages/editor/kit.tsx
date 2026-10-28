/**
 * Declarative building blocks for the Editor pages, closer to IDEA's forms
 * than `OptionsPage`: checkboxes with dependent (indented, disabled when
 * off) options, inline controls ("Show the documentation popup in [500] ms"),
 * radio groups and two-column checkbox grids. Labels of every item are
 * collected for the settings search.
 */
import { createContext, useContext, useId, type ComponentType, type ReactNode } from "react";
import clsx from "clsx";
import { Checkbox, Input, type SelectOption } from "@/ui";
import { tx } from "@/platform/i18n";
import { NumberInput, Row, SearchLabel, Section, Select } from "../../components/Form";
import { useLabelMatch, useSetting } from "../../components/context";
import type { PageSpec } from "../spec";
import styles from "./Editor.module.css";

export type Inline =
  | { kind: "number"; key: string; min: number; max: number; unit?: string; suffix?: string }
  | { kind: "select"; key: string; options: readonly SelectOption[]; suffix?: string };

export type Item =
  | {
      t: "check";
      key: string;
      label: string;
      hint?: ReactNode;
      /** Checked when the stored boolean is false (e.g. "Disable …"). */
      invert?: boolean;
      /** Control after the label; disabled while unchecked. */
      inline?: Inline;
      /** Dependent options, indented and disabled while unchecked. */
      children?: Item[];
    }
  | { t: "number"; key: string; label: string; min: number; max: number; unit?: string; hint?: ReactNode }
  | { t: "select"; key: string; label: string; options: readonly SelectOption[]; hint?: ReactNode }
  | { t: "radio"; key: string; label: string; options: readonly SelectOption[]; hint?: ReactNode }
  | { t: "text"; key: string; label: string; placeholder?: string; hint?: ReactNode; wide?: boolean }
  | { t: "grid"; columns: Item[][] }
  | { t: "custom"; label: string; keywords?: string[]; component: ComponentType }
  | { t: "note"; text: string };

export interface EditorSection {
  title?: string;
  items: Item[];
}

export interface EditorPageDef {
  id: string;
  title: string;
  order: number;
  group?: string;
  keywords?: string[];
  projectScope?: boolean;
  sections: EditorSection[];
  /** Rendered below the sections (previews, tables). */
  footer?: ComponentType;
}

const Disabled = createContext(false);

function CheckItem({ item }: { item: Extract<Item, { t: "check" }> }) {
  const parentDisabled = useContext(Disabled);
  const [raw, set] = useSetting<boolean>(item.key);
  const checked = item.invert ? !raw : !!raw;
  const matched = useLabelMatch(item.label);
  const off = parentDisabled || !checked;
  return (
    <>
      <div className={clsx(styles.check, matched && styles.matched)} data-search-match={matched || undefined}>
        <Checkbox
          checked={checked}
          disabled={parentDisabled}
          onChange={(v) => set(item.invert ? !v : v)}
          label={<SearchLabel text={item.label} />}
        />
        {item.inline && <InlineControl inline={item.inline} label={item.label} disabled={off} />}
      </div>
      {item.hint && <div className={styles.checkHint}>{item.hint}</div>}
      {item.children && (
        <Disabled.Provider value={off}>
          <div className={styles.children}>
            {item.children.map((c, i) => (
              <ItemView key={i} item={c} />
            ))}
          </div>
        </Disabled.Provider>
      )}
    </>
  );
}

function InlineControl({ inline, label, disabled }: { inline: Inline; label: string; disabled: boolean }) {
  if (inline.kind === "number") return <InlineNumber inline={inline} label={label} disabled={disabled} />;
  return <InlineSelect inline={inline} label={label} disabled={disabled} />;
}

function InlineNumber({
  inline,
  label,
  disabled,
}: {
  inline: Extract<Inline, { kind: "number" }>;
  label: string;
  disabled: boolean;
}) {
  const [value, set] = useSetting<number>(inline.key);
  return (
    <span className={clsx(styles.inline, disabled && styles.dim)}>
      {disabled ? (
        <Input className={styles.inlineNumber} value={String(value)} disabled aria-label={label} readOnly />
      ) : (
        <NumberInput value={value} onChange={set} min={inline.min} max={inline.max} integer aria-label={label} />
      )}
      {(inline.unit ?? inline.suffix) && <span className={styles.suffix}>{inline.unit ?? inline.suffix}</span>}
    </span>
  );
}

function InlineSelect({
  inline,
  label,
  disabled,
}: {
  inline: Extract<Inline, { kind: "select" }>;
  label: string;
  disabled: boolean;
}) {
  const [value, set] = useSetting<string>(inline.key);
  return (
    <span className={clsx(styles.inline, disabled && styles.dim)}>
      {disabled ? (
        <Input
          className={styles.inlineText}
          value={tx(inline.options.find((o) => o.value === value)?.label ?? value)}
          disabled
          readOnly
          aria-label={label}
        />
      ) : (
        <Select value={value} options={inline.options} onChange={set} aria-label={label} />
      )}
      {inline.suffix && <span className={styles.suffix}>{inline.suffix}</span>}
    </span>
  );
}

function NumberItem({ item }: { item: Extract<Item, { t: "number" }> }) {
  const disabled = useContext(Disabled);
  const [value, set] = useSetting<number>(item.key);
  const id = useId();
  return (
    <Row label={item.label} hint={item.hint} htmlFor={id} className={clsx(disabled && styles.dim)}>
      {disabled ? (
        <Input id={id} className={styles.inlineNumber} value={String(value)} disabled readOnly />
      ) : (
        <NumberInput
          id={id}
          value={value}
          onChange={set}
          min={item.min}
          max={item.max}
          integer
          aria-label={item.label}
          unit={item.unit}
        />
      )}
    </Row>
  );
}

function SelectItem({ item }: { item: Extract<Item, { t: "select" }> }) {
  const disabled = useContext(Disabled);
  const [value, set] = useSetting<string>(item.key);
  return (
    <Row label={item.label} hint={item.hint} className={clsx(disabled && styles.dim)}>
      {disabled ? (
        <Input
          className={styles.inlineText}
          value={tx(item.options.find((o) => o.value === value)?.label ?? value)}
          disabled
          readOnly
          aria-label={item.label}
        />
      ) : (
        <Select value={value} options={item.options} onChange={set} aria-label={item.label} />
      )}
    </Row>
  );
}

function RadioItem({ item }: { item: Extract<Item, { t: "radio" }> }) {
  const disabled = useContext(Disabled);
  const [value, set] = useSetting<string>(item.key);
  const name = useId();
  const matched = useLabelMatch(item.label);
  return (
    <div className={clsx(styles.radioBlock, matched && styles.matched)} role="radiogroup" aria-label={item.label}>
      {item.label && (
        <div className={clsx(styles.radioLabel, disabled && styles.dim)}>
          <SearchLabel text={item.label} />:
        </div>
      )}
      <div className={styles.radios}>
        {item.options.map((o) => (
          <label key={o.value} className={clsx(styles.radio, disabled && styles.dim)}>
            <input
              type="radio"
              name={name}
              checked={value === o.value}
              disabled={disabled}
              onChange={() => set(o.value)}
            />
            <SearchLabel text={o.label} />
          </label>
        ))}
      </div>
      {item.hint && <div className={styles.checkHint}>{item.hint}</div>}
    </div>
  );
}

function TextItem({ item }: { item: Extract<Item, { t: "text" }> }) {
  const disabled = useContext(Disabled);
  const [value, set] = useSetting<string>(item.key);
  const id = useId();
  return (
    <Row label={item.label} hint={item.hint} htmlFor={id} className={clsx(disabled && styles.dim)}>
      <Input
        id={id}
        className={item.wide ? styles.wideText : styles.text}
        value={value}
        disabled={disabled}
        placeholder={item.placeholder}
        onChange={(e) => set(e.target.value)}
      />
    </Row>
  );
}

export function ItemView({ item }: { item: Item }) {
  switch (item.t) {
    case "check":
      return <CheckItem item={item} />;
    case "number":
      return <NumberItem item={item} />;
    case "select":
      return <SelectItem item={item} />;
    case "radio":
      return <RadioItem item={item} />;
    case "text":
      return <TextItem item={item} />;
    case "grid":
      return (
        <div className={styles.grid}>
          {item.columns.map((col, i) => (
            <div key={i} className={styles.column}>
              {col.map((c, j) => (
                <ItemView key={j} item={c} />
              ))}
            </div>
          ))}
        </div>
      );
    case "custom": {
      const C = item.component;
      return <C />;
    }
    case "note":
      return <div className={styles.note}>{item.text}</div>;
  }
}

export function EditorSections({ sections }: { sections: EditorSection[] }) {
  return (
    <>
      {sections.map((s, i) => (
        <Section key={s.title ?? i} title={s.title}>
          {s.items.map((item, j) => (
            <ItemView key={j} item={item} />
          ))}
        </Section>
      ))}
    </>
  );
}

/** Search texts of an item tree (labels, option labels, custom keywords). */
export function itemLabels(items: readonly Item[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.t === "grid") out.push(...it.columns.flatMap((c) => itemLabels(c)));
    else if (it.t === "note") continue;
    else {
      out.push(it.label);
      if (it.t === "custom") out.push(...(it.keywords ?? []));
      if (it.t === "select" || it.t === "radio") out.push(...it.options.map((o) => o.label));
      if (it.t === "check" && it.inline?.kind === "select") out.push(...it.inline.options.map((o) => o.label));
      if (it.t === "check" && it.children) out.push(...itemLabels(it.children));
    }
  }
  return out;
}

export function sectionLabels(sections: readonly EditorSection[]): string[] {
  return sections.flatMap((s) => [...(s.title ? [s.title] : []), ...itemLabels(s.items)]);
}

/** Turns a page definition into a settings page spec (rendered by `EditorSections`). */
export function editorPage(def: EditorPageDef): PageSpec {
  const Footer = def.footer;
  const Page = () => (
    <div className={styles.page}>
      <EditorSections sections={def.sections} />
      {Footer && <Footer />}
    </div>
  );
  Page.displayName = `EditorPage(${def.id})`;
  return {
    id: def.id,
    title: def.title,
    group: def.group ?? "Editor",
    order: def.order,
    keywords: def.keywords,
    projectScope: def.projectScope,
    component: Page,
    dynamicLabels: () => sectionLabels(def.sections),
  };
}
