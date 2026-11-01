import { useId, useState } from "react";
import { DEFAULT_CMAKE_PROFILE, type CMakeProfileValid } from "@/platform/cmakeSettings";
import { formatArgs, parseArgs } from "@/platform/commandLine";
import { tx } from "@/platform/i18n";
import { IconButton, Input, T } from "@/ui";
import { Row, Section } from "../components/Form";
import { useSetting } from "../components/context";
import { TableEditor } from "./workflowControls";
import styles from "./Workflow.module.css";
import own from "./CMake.module.css";

function ArgumentsInput({ id, value, onChange }: { id: string; value: string[]; onChange: (args: string[]) => void }) {
  const [text, setText] = useState<string>();
  return (
    <Input
      id={id}
      className={styles.wide}
      value={text ?? formatArgs(value)}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseArgs(e.target.value));
      }}
      onBlur={() => setText(undefined)}
    />
  );
}

export function CMakeProfiles() {
  const [saved, setProfiles] = useSetting<CMakeProfileValid[] | undefined>("cmake.profiles");
  const profiles = saved ?? [DEFAULT_CMAKE_PROFILE];
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, Math.max(0, profiles.length - 1));
  const current = profiles[index];
  const id = useId();
  const update = (patch: Partial<CMakeProfileValid>) =>
    setProfiles(profiles.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  const fields = [
    ["name", "Name"],
    ["buildType", "Build type"],
    ["generator", "Generator"],
    ["cmakeArgs", "CMake arguments"],
    ["buildDir", "Build directory"],
    ["buildArgs", "Build arguments"],
  ] as const;
  return (
    <div className={styles.toolsLayout}>
      <Section title="CMake profiles">
        <div className={styles.tableBox}>
          <div className={styles.toolbar} role="toolbar" aria-label={tx("CMake profile actions")}>
            <IconButton
              icon="plus"
              title="Add"
              size="small"
              onClick={() => {
                setProfiles([
                  ...profiles,
                  { ...DEFAULT_CMAKE_PROFILE, name: tx`CMake profile ${profiles.length + 1}`, env: {} },
                ]);
                setSelected(profiles.length);
              }}
            />
            <IconButton
              icon="minus"
              title="Remove"
              size="small"
              disabled={!current}
              onClick={() => {
                setProfiles(profiles.filter((_, i) => i !== index));
                setSelected(Math.max(0, index - 1));
              }}
            />
          </div>
          <div className={styles.toolList} role="listbox" aria-label={tx("CMake profiles")}>
            {profiles.map((p, i) => (
              <button
                type="button"
                key={i}
                role="option"
                aria-selected={index === i}
                className={`${own.profile} ${styles.toolRow} ${index === i ? styles.toolRowSelected : ""}`}
                onClick={() => setSelected(i)}
              >
                {p.name}
              </button>
            ))}
            {profiles.length === 0 && <T>No CMake profiles. Click + to add one.</T>}
          </div>
        </div>
      </Section>
      {current && (
        <Section title="Profile settings">
          {fields.map(([key, label]) => (
            <Row key={key} label={label} htmlFor={`${id}-${key}`} className={styles.alignedRow}>
              {key === "cmakeArgs" || key === "buildArgs" ? (
                <ArgumentsInput
                  key={index}
                  id={`${id}-${key}`}
                  value={current[key]}
                  onChange={(args) => update({ [key]: args })}
                />
              ) : (
                <Input
                  id={`${id}-${key}`}
                  className={styles.wide}
                  value={current[key]}
                  list={key === "buildType" || key === "generator" ? `${id}-${key}-options` : undefined}
                  placeholder={
                    key === "buildDir"
                      ? "cmake-build-" + current.buildType.toLowerCase()
                      : key === "generator"
                        ? tx("CMake default")
                        : undefined
                  }
                  onChange={(e) => update({ [key]: e.target.value })}
                />
              )}
            </Row>
          ))}
          <datalist id={`${id}-buildType-options`}>
            {["Debug", "Release", "RelWithDebInfo", "MinSizeRel"].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <datalist id={`${id}-generator-options`}>
            {["Ninja", "Unix Makefiles", "Ninja Multi-Config", "Visual Studio 17 2022", "Xcode"].map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <Row label="Environment variables" stacked>
            <TableEditor
              rows={Object.entries(current.env).map(([name, value]) => ({ name, value }))}
              columns={[
                { key: "name", title: "Name", placeholder: "NAME" },
                { key: "value", title: "Value", placeholder: "value" },
              ]}
              onChange={(rows) => update({ env: Object.fromEntries(rows.map((r) => [r.name ?? "", r.value ?? ""])) })}
              empty="No variables"
              aria-label="Environment variables"
            />
          </Row>
          <div className={styles.note}>
            <T>
              Quote arguments containing spaces. Build arguments go to cmake --build; use -- before native build tool
              options.
            </T>
          </div>
        </Section>
      )}
    </div>
  );
}
