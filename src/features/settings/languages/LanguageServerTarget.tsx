import { useEffect, useState } from "react";
import type { LanguageInfo, LanguageServerTarget } from "@/bindings";
import { commands } from "@/platform/ipc";
import { usePluginRunTargets } from "@/platform/pluginRunTargets";
import { useProject } from "@/platform/project";
import { useLanguageListVersion } from "@/platform/languageList";
import { type SelectOption } from "@/ui";
import { Row, Section, Select } from "../components/Form";
import { useSetting } from "../components/context";
import { useSettingsDialog } from "../model/staging";

function useServerLanguages() {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const version = useLanguageListVersion((s) => s.version);
  useEffect(() => {
    let alive = true;
    void commands.languages().then(
      (list) => alive && setLanguages(list),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [version]);
  return languages.filter((l) => l.languageServers?.length);
}

function TargetField({ language, servers }: { language: string; servers: string[] }) {
  const [selections, setSelections] = useSetting<Record<string, LanguageServerTarget>>(
    "languageServerTargets",
    "project",
  );
  const targets = usePluginRunTargets((s) => s.targets);
  const project = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const selection = selections?.[language] ?? { target: "", server: "" };
  const set = (patch: Partial<LanguageServerTarget>) =>
    setSelections({ ...selections, [language]: { ...selection, ...patch } });
  const options: SelectOption[] = [
    { value: "", label: "Local machine" },
    ...targets.map((t) => ({
      value: t.id,
      label: t.target.name,
      disabled: !t.target.containerRoot,
      detail: t.target.containerRoot ? t.pluginName : "Requires a container root for path mapping",
    })),
  ];
  if (selection.target && !targets.some((t) => t.id === selection.target))
    options.push({
      value: selection.target,
      label: selection.target,
      detail: "Target unavailable; language server runs on the host",
    });
  return (
    <>
      <Row
        label="Language server runs on"
        hint="Project only. Install the selected server inside the target; IDE downloads are host binaries."
      >
        <Select
          value={selection.target ?? ""}
          options={options}
          onChange={(target) => set({ target })}
          disabled={!project || newProjects}
          aria-label="Language server runs on"
        />
      </Row>
      {selection.target && (
        <Row label="Language server">
          <Select
            value={selection.server ?? ""}
            options={[
              { value: "", label: "First configured server" },
              ...servers.map((name) => ({ value: name, label: name })),
            ]}
            onChange={(server) => set({ server })}
            disabled={!project || newProjects}
            aria-label="Language server"
          />
        </Row>
      )}
    </>
  );
}

export function LanguageServerTargetRows({ language }: { language: string }) {
  const languages = useServerLanguages();
  const selected = languages.find((l) => l.id === language);
  return <TargetField language={language} servers={selected?.languageServers ?? []} />;
}

/** All languages, including plugin languages and languages without an interpreter page. */
export function LanguageServerTargetsPage({ ids }: { ids?: string[] }) {
  const languages = useServerLanguages();
  const [chosen, setChosen] = useState("php");
  const available = ids ? languages.filter((l) => ids.includes(l.id)) : languages;
  const selected = available.find((l) => l.id === chosen) ?? available[0];
  return (
    <Section title="Language server targets">
      <Row label="Language">
        <Select
          value={selected?.id ?? ""}
          options={available.map((l) => ({ value: l.id, label: l.name }))}
          onChange={setChosen}
          aria-label="Language"
        />
      </Row>
      {selected && <TargetField language={selected.id} servers={selected.languageServers ?? []} />}
    </Section>
  );
}
