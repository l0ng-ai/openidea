/**
 * GraphQL Environment Variables (IDEA's dialog): the `${NAME}` variables a graphql-config
 * uses, one row each with its value; Copy / Paste exchange them as `NAME=value` lines.
 */
import { useState } from "react";
import { readClipboardText } from "@/platform/clipboard";
import { useTx } from "@/platform/i18n";
import { Dialog, IconButton, T } from "@/ui";
import { copyText } from "@/ui/selectableText";
import { closeEnvironmentDialog, environmentOf, saveEnvironment, useGraphQL } from "./store";
import styles from "./GraphQL.module.css";

/** `NAME=value` lines (a `.env` file's shape). */
export function formatEnvironment(names: readonly string[], values: Readonly<Record<string, string>>): string {
  return names.map((n) => `${n}=${values[n] ?? ""}`).join("\n");
}

/** Values of `names` found in `NAME=value` lines; other lines are ignored. */
export function parseEnvironment(text: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (names.includes(name)) out[name] = line.slice(at + 1).trim();
  }
  return out;
}

export function EnvironmentDialogOverlay() {
  const dialog = useGraphQL((s) => s.envDialog);
  return dialog ? <EnvironmentDialog key={dialog.configPath} {...dialog} /> : null;
}

function EnvironmentDialog({ configPath, variables }: { configPath: string; variables: string[] }) {
  const tx = useTx();
  const [values, setValues] = useState(() => ({ ...environmentOf(configPath) }));
  const ok = () => {
    saveEnvironment(configPath, values);
    closeEnvironmentDialog(true);
  };
  return (
    <Dialog
      open
      title="GraphQL Environment Variables"
      onClose={() => closeEnvironmentDialog(false)}
      width={480}
      buttons={[
        { label: "OK", role: "default", onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.envBox}>
        <div className={styles.envToolbar} role="toolbar" aria-label={tx("Environment variables actions")}>
          <IconButton
            icon="copy"
            size="small"
            title="Copy"
            onClick={() => void copyText(formatEnvironment(variables, values))}
          />
          <IconButton
            icon="paste"
            size="small"
            title="Paste"
            onClick={() =>
              void readClipboardText().then((text) =>
                setValues((v) => ({ ...v, ...parseEnvironment(text, variables) })),
              )
            }
          />
        </div>
        <table className={styles.envTable} aria-label={tx("Environment variables")}>
          <thead>
            <tr>
              <th>
                <T>Name</T>
              </th>
              <th>
                <T>Value</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {variables.map((name) => (
              <tr key={name}>
                <td className={styles.envName}>{name}</td>
                <td>
                  <input
                    className={styles.envValue}
                    aria-label={name}
                    spellCheck={false}
                    value={values[name] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") ok();
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
