/** Settings › Editor › Vim: on/off, the rc file, and IdeaVim's "Shortcut conflicts" table. */
import { useEffect, useMemo } from "react";
import { useActions } from "@/platform/actions";
import { effectiveBindings, formatBinding, useKeymap } from "@/platform/keymap";
import { Button, Checkbox, Select, T } from "@/ui";
import { conflictRows, VIM_KEYS } from "./conflicts";
import { loadRcFile, useVimRc } from "./rcFile";
import { updateVimSettings, useVimSettings, type Handler } from "./settings";
import styles from "./Vim.module.css";

const HANDLERS = [
  { value: "vim" as const, label: "Vim" },
  { value: "ide" as const, label: "IDE" },
];

export function VimSettingsPage() {
  const s = useVimSettings();
  const rc = useVimRc();
  const keymap = useKeymap();
  const actions = useActions((a) => a.actions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the keymap store is the input of effectiveBindings()
  const rows = useMemo(() => conflictRows(effectiveBindings(), s.handlers), [keymap, s.handlers]);

  useEffect(() => {
    if (!useVimRc.getState().loaded) void loadRcFile();
  }, []);

  const setHandler = (stroke: string, handler: Handler) => {
    const handlers = { ...s.handlers };
    if (VIM_KEYS.find((k) => k.stroke === stroke)?.handler === handler) delete handlers[stroke];
    else handlers[stroke] = handler;
    updateVimSettings({ handlers });
  };

  return (
    <div className={styles.page}>
      <Checkbox
        checked={s.enabled}
        onChange={(enabled) => updateVimSettings({ enabled })}
        label="Enable Vim emulation"
      />

      <section className={styles.section} aria-label="Vim rc file">
        <div className={styles.header}>
          <span>
            <T>Configuration file</T>
          </span>
          <Button size="small" onClick={() => void loadRcFile()}>
            Reload
          </Button>
        </div>
        <p className={styles.hint}>
          {rc.path ? (
            <>
              <code className={styles.mono}>{rc.path}</code> · {rc.mappings} <T>mappings</T>
            </>
          ) : (
            <T>No ~/.openideavimrc or ~/.ideavimrc found.</T>
          )}
        </p>
        <p className={styles.hint}>
          <T>
            Supported: set options, map / nmap / imap / vmap / noremap variants, let mapleader, and :action /
            &lt;Action&gt;() mappings that run IDE actions. :w saves, :q closes the editor tab.
          </T>
        </p>
        {rc.ignored.length > 0 && (
          <ul className={styles.ignored} aria-label="Ignored lines">
            {rc.ignored.map((i) => (
              <li key={i.line}>
                <span className={styles.mono}>
                  {i.line}: {i.text}
                </span>{" "}
                — {i.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label="Shortcut conflicts">
        <div className={styles.header}>
          <span>
            <T>Shortcut conflicts</T>
          </span>
        </div>
        <p className={styles.hint}>
          <T>
            Keys Vim also handles. With Vim as the handler the key goes to the editor while Vim mode is on and an editor
            has focus; with IDE, an enabled IDE action runs first.
          </T>
        </p>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <T>Shortcut</T>
              </th>
              <th>
                <T>IDE action</T>
              </th>
              <th>
                <T>Vim</T>
              </th>
              <th>
                <T>Handler</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.stroke}>
                <td className={styles.mono}>{formatBinding(r.stroke)}</td>
                <td>{r.actions.length ? r.actions.map((id) => actions.get(id)?.title ?? id).join(", ") : "—"}</td>
                <td>
                  <T>{r.vim}</T>
                </td>
                <td>
                  <Select
                    value={r.current}
                    options={HANDLERS}
                    onChange={(v) => setHandler(r.stroke, v)}
                    aria-label={`Handler for ${r.stroke}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <Button
            size="small"
            onClick={() => updateVimSettings({ handlers: {} })}
            disabled={!Object.keys(s.handlers).length}
          >
            Reset to Defaults
          </Button>
        </div>
      </section>
    </div>
  );
}
