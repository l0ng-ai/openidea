import { useEffect, useState } from "react";
import { call, commands, type FormatterChoice } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Row, Section, Select, Toggle } from "../components/Form";
import { useSetting } from "../components/context";
export function PluginFormattersPage() {
  const [known, setKnown] = useState<string[]>([]);
  const [choices, setChoices] = useState<FormatterChoice[]>([]);
  const [selected, setSelected] = useSetting<Record<string, string>>("languages.pluginFormatters");
  const [save, setSave] = useSetting<boolean>("editor.formatOnSave");
  useEffect(() => {
    let active = true;
    void call(commands.pluginFormatters())
      .then((v) => {
        if (active) setChoices(v);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    void commands
      .languages()
      .then((list) => setKnown(list.map((l) => l.id)))
      .catch(() => {});
  }, []);
  const languages = [
    ...new Set([...known, ...Object.keys(selected ?? {}), ...choices.flatMap((c) => c.languages)]),
  ].filter(
    (l) => l !== "*" && (selected?.[l] || choices.some((c) => c.languages.includes(l) || c.languages.includes("*"))),
  );
  return (
    <Section title="Plugin Formatters">
      {languages.map((language) => (
        <Row key={language} label={language}>
          <Select
            aria-label={language}
            value={selected?.[language] ?? ""}
            onChange={(value) => setSelected({ ...selected, [language]: value })}
            options={[
              { value: "", label: tx("Automatic (language server first)") },
              ...choices
                .filter((c) => c.languages.includes(language) || c.languages.includes("*"))
                .map((c) => ({ value: c.id, label: c.name })),
              ...(selected?.[language] && !choices.some((c) => c.id === selected[language])
                ? [{ value: selected[language]!, label: selected[language]! }]
                : []),
            ]}
          />
        </Row>
      ))}
      <Toggle label="Format on save" checked={save} onChange={setSave} />
    </Section>
  );
}
