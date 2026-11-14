/**
 * "Run Artisan Command…": the project's Artisan commands (from the native PHP engine),
 * filtered by name or description; the chosen command runs with the arguments typed
 * below it as a temporary "Artisan Command" configuration, or is saved as one.
 */
import { useMemo, useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import type { LaravelArtisanCommand } from "@/platform/ipc";
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { Dialog, Input, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { artisanConfig, loadArtisanCommands, optionSuggestions } from "./artisan";
import styles from "./ArtisanDialog.module.css";

const useArtisanDialog = create<{ commands: LaravelArtisanCommand[] | null }>(() => ({ commands: null }));

/** Opens the dialog; outside Laravel projects (or without the native PHP engine) says so instead. */
export async function openArtisanDialog() {
  const found = await loadArtisanCommands(true);
  if (!found) {
    notifications().notify({
      group: "run",
      level: "info",
      title: "No Artisan commands",
      body: "Artisan commands are listed for Laravel projects while the native PHP engine is on.",
      key: "artisan-commands",
    });
    return;
  }
  useArtisanDialog.setState({ commands: found });
}

/** Commands matching `filter` (name first, then description), in order. */
export function filterCommands(commands: readonly LaravelArtisanCommand[], filter: string): LaravelArtisanCommand[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...commands];
  const byName = commands.filter((c) => c.name.toLowerCase().includes(q));
  const byDescription = commands.filter(
    (c) => !c.name.toLowerCase().includes(q) && c.description.toLowerCase().includes(q),
  );
  return [...byName, ...byDescription];
}

function ArtisanDialog({ commands }: { commands: LaravelArtisanCommand[] }) {
  const tx = useTx();
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(commands[0]?.name ?? null);
  const [args, setArgs] = useState("");
  const shown = useMemo(() => filterCommands(commands, filter), [commands, filter]);
  const command = shown.find((c) => c.name === selected) ?? shown[0];
  /** Another command's arguments start empty. */
  const choose = (name: string) => {
    if (name !== command?.name) setArgs("");
    setSelected(name);
  };
  const close = () => useArtisanDialog.setState({ commands: null });
  const run = (debug: boolean) => {
    if (!command) return;
    close();
    void executeAction(debug ? "run.debugConfig" : "run.runConfig", {
      config: artisanConfig(command.name, args),
      temporary: true,
    });
  };
  const save = () => {
    if (!command) return;
    close();
    void executeAction("run.createConfig", artisanConfig(command.name, args));
  };
  const move = (by: number) => {
    if (!shown.length) return;
    const at = command ? shown.indexOf(command) : -1;
    choose(shown[Math.min(shown.length - 1, Math.max(0, at + by))]!.name);
  };
  const options = optionSuggestions(command, args);
  return (
    <Dialog
      open
      title="Run Artisan Command"
      onClose={close}
      width={620}
      buttons={[
        {
          label: "Run",
          role: "default",
          disabled: !command,
          onClick: () => run(false),
        },
        { label: "Debug", disabled: !command, onClick: () => run(true) },
        { label: "Save as Configuration", disabled: !command, onClick: save },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.body}>
        <Input
          autoFocus
          aria-label="Filter commands"
          placeholder="Filter commands"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter" && command) {
              e.preventDefault();
              run(false);
            }
          }}
        />
        <div className={styles.list} role="listbox" aria-label={tx("Artisan commands")}>
          {shown.length === 0 && (
            <div className={styles.empty}>
              <T>No matching commands</T>
            </div>
          )}
          {shown.map((c) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={c === command}
              className={clsx(styles.item, c === command && styles.selected)}
              onClick={() => choose(c.name)}
              onDoubleClick={() => {
                choose(c.name);
                run(false);
              }}
            >
              <span className={styles.name}>{c.name}</span>
              <span className={styles.description}>{c.description}</span>
            </button>
          ))}
        </div>
        {command && <div className={styles.synopsis}>php artisan {command.synopsis}</div>}
        <Input
          mono
          aria-label="Arguments and options"
          placeholder="Arguments and options"
          value={args}
          list={options.length ? "artisan-dialog-options" : undefined}
          onChange={(e) => setArgs(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && command) {
              e.preventDefault();
              run(false);
            }
          }}
        />
        {options.length > 0 && (
          <datalist id="artisan-dialog-options">
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </div>
    </Dialog>
  );
}

export function ArtisanDialogOverlay() {
  const commands = useArtisanDialog((s) => s.commands);
  return commands ? <ArtisanDialog commands={commands} /> : null;
}
