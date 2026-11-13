/**
 * The New CLI tab (#2202): the saved CLIs as cards, one click starts one as an
 * editor tab; "Add CLI…" saves a name + command for all projects, and a plain
 * login shell opens the same way. The terminal tool window keeps its own tabs.
 */
import { useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Button, IconButton, Input, T } from "@/ui";
import { launchCli, removeSavedCli, saveCli, useSavedClis } from "./cli";
import styles from "./Cli.module.css";

export function CliLauncher() {
  const saved = useSavedClis((s) => s.saved);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  const canAdd = !!name.trim() && !!command.trim();
  const reset = () => {
    setName("");
    setCommand("");
    setAdding(false);
  };
  const add = () => {
    if (!canAdd) return;
    saveCli(name, command);
    reset();
  };
  const onFormKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      reset();
    }
  };

  return (
    <div className={styles.start}>
      <div className={styles.startInner}>
        <h1 className={styles.heading}>
          <T>New CLI</T>
        </h1>
        <div className={styles.cards}>
          {saved.map((s) => (
            <div key={s.id} className={styles.card}>
              <button type="button" className={styles.cardButton} onClick={() => void launchCli(s.name, s.command)}>
                <span className={styles.cardName}>{s.name}</span>
                <span className={styles.cardCommand}>{s.command}</span>
              </button>
              <IconButton
                icon="close"
                size="small"
                title="Remove"
                className={styles.cardRemove}
                onClick={() => removeSavedCli(s.id)}
              />
            </div>
          ))}
          {saved.length === 0 && (
            <p className={styles.note}>
              <T>No saved CLIs yet — add one, or open a plain shell.</T>
            </p>
          )}
        </div>
        {adding ? (
          <div className={styles.form} onKeyDown={onFormKeyDown}>
            <Input
              autoFocus
              placeholder="Name"
              aria-label="Name"
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") add();
              }}
            />
            <Input
              mono
              placeholder="Command"
              aria-label="Command"
              value={command}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setCommand(e.target.value)}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") add();
              }}
            />
            <div className={styles.formActions}>
              <Button variant="primary" disabled={!canAdd} onClick={add}>
                <T>Add</T>
              </Button>
              <Button onClick={reset}>
                <T>Cancel</T>
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.formActions}>
            <Button onClick={() => setAdding(true)}>
              <T>Add CLI…</T>
            </Button>
            <Button onClick={() => void launchCli("Shell", "")}>
              <T>Open Shell</T>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
