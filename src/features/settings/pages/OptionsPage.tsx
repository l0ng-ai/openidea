import { FormGroup, Section, SettingNumber, SettingSelect, SettingText, SettingToggle } from "../components/Form";
import { useSetting } from "../components/context";
import type { OptionSpec, PageSpec } from "./spec";
import styles from "./Pages.module.css";

const optionKey = (o: OptionSpec) => ("key" in o ? o.key : o.label);

function Option({ o, disabled }: { o: OptionSpec; disabled?: boolean }) {
  switch (o.kind) {
    case "toggle":
      return <ToggleOption o={o} disabled={disabled} />;
    case "number":
      return (
        <SettingNumber
          k={o.key}
          label={o.label}
          hint={o.hint}
          min={o.min}
          max={o.max}
          step={o.step}
          integer={o.integer}
          unit={o.unit}
          disabled={disabled}
        />
      );
    case "select":
      return <SettingSelect k={o.key} label={o.label} hint={o.hint} options={o.options} disabled={disabled} />;
    case "text":
      return <SettingText k={o.key} label={o.label} hint={o.hint} placeholder={o.placeholder} disabled={disabled} />;
    case "custom": {
      const C = o.component;
      return <C />;
    }
  }
}

/** A checkbox and its dependent options, indented and disabled while it is unchecked. */
function ToggleOption({ o, disabled }: { o: Extract<OptionSpec, { kind: "toggle" }>; disabled?: boolean }) {
  const [on] = useSetting<boolean>(o.key);
  return (
    <>
      <SettingToggle k={o.key} label={o.label} hint={o.hint} disabled={disabled} />
      {o.children && (
        <FormGroup indented>
          {o.children.map((c) => (
            <Option key={optionKey(c)} o={c} disabled={disabled || !on} />
          ))}
        </FormGroup>
      )}
    </>
  );
}

/** Renders a declarative page spec. */
export function OptionsPage({ spec }: { spec: PageSpec }) {
  const Footer = spec.footer;
  return (
    <div className={styles.options}>
      {spec.sections?.map((section, i) => (
        <Section key={section.title ?? i} title={section.title}>
          {section.options.map((o) => (
            <Option key={optionKey(o)} o={o} />
          ))}
        </Section>
      ))}
      {Footer && <Footer />}
    </div>
  );
}
