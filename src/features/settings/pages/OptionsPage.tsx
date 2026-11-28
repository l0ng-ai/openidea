import type { ReactNode } from "react";
import {
  FormGroup,
  Section,
  SettingNumber,
  SettingSelect,
  SettingText,
  SettingToggle,
  Toggle,
} from "../components/Form";
import { useSetting } from "../components/context";
import type { MasterToggleSpec, OptionSpec, PageSpec } from "./spec";
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
  const body = (
    <>
      {spec.sections?.map((section, i) => (
        <Section key={section.title ?? i} title={section.title}>
          {section.options.map((o) => (
            <Option key={optionKey(o)} o={o} />
          ))}
        </Section>
      ))}
      {Footer && <Footer />}
    </>
  );
  return (
    <div className={styles.options}>{spec.master ? <MasterGate master={spec.master}>{body}</MasterGate> : body}</div>
  );
}

/** The page's master checkbox; while it is unchecked the rest of the page is dimmed and inert. */
function MasterGate({ master, children }: { master: MasterToggleSpec; children: ReactNode }) {
  const [on, set] = useSetting<boolean>(master.key, master.scope);
  const off = !on;
  return (
    <>
      <Section>
        <Toggle label={master.label} checked={!!on} onChange={set} hint={master.hint} />
      </Section>
      <fieldset disabled={off} inert={off} aria-disabled={off} className={off ? styles.gatedOff : styles.gated}>
        {children}
      </fieldset>
    </>
  );
}
