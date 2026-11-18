/** Settings › Editor › Vim: on/off, the rc file, and IdeaVim's "Shortcut conflicts" table. */
import { useEffect, useMemo } from "react";
import { executeAction, useActions } from "@/platform/actions";
import { auxiliaryWindow } from "@/platform/auxWindow";
import { effectiveBindings, formatBinding, useKeymap } from "@/platform/keymap";
import { Button, Checkbox, Select, T } from "@/ui";
import { conflictRows, VIM_KEYS } from "./conflicts";
import { loadRcFile, useVimRc } from "./rcFile";
import { updateVimSettings, useVimSettings, type Handler } from "./settings";
import styles from "./Vim.module.css";
import { tx } from "@/platform/i18n";
import { useSettingsForm } from "@/workbench/contributions";

const HANDLERS = [
  { value: "vim" as const, label: "Vim" },
  { value: "ide" as const, label: "IDE" },
];

export function VimSettingsPage() {
  const form = useSettingsForm();
  const saved = useVimSettings();
  const enabled = form.useExternal("enabled", saved.enabled, async (value) => {
    updateVimSettings({ enabled: value });
    return value;
  });
  const { value: handlers, set: setHandlers } = form.useExternal("handlers", saved.handlers, async (value) => {
    updateVimSettings({ handlers: value });
    return value;
  });
  const rc = useVimRc();
  const keymap = useKeymap();
  const actions = useActions((a) => a.actions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the keymap store is the input of effectiveBindings()
  const rows = useMemo(() => conflictRows(effectiveBindings(), handlers), [keymap, handlers]);

  useEffect(() => {
    if (!useVimRc.getState().loaded) void loadRcFile();
  }, []);

  const reload = async () => {
    await executeAction("vim.reloadRc", "settings");
    // The native Settings window forwards the action to its editor window.
    if (auxiliaryWindow()?.kind === "settings") await loadRcFile();
  };

  const setHandler = (stroke: string, handler: Handler) => {
    const next = { ...handlers };
    if (VIM_KEYS.find((k) => k.stroke === stroke)?.handler === handler) delete next[stroke];
    else next[stroke] = handler;
    setHandlers(next);
  };

  return (
    <div className={styles.page}>
      <Checkbox checked={enabled.value} onChange={enabled.set} label="Enable Vim emulation" />

      <section className={styles.section} aria-label={tx("Vim rc file")}>
        <div className={styles.header}>
          <span>
            <T>Configuration file</T>
          </span>
          <Button size="small" disabled={!actions.has("vim.reloadRc")} onClick={() => void reload()}>
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
            Supported: set options, map / nmap / imap / vmap / noremap variants, let mapleader, source, and :action /
            &lt;Action&gt;() mappings that run IDE actions. :w saves, :q closes the editor tab.
          </T>
        </p>
        <p className={styles.hint}>
          <T>
            Unnamed yanks and deletes stay in Vim's registers. Add set clipboard+=unnamed (or set clipboard=unnamedplus)
            to the rc file to mirror them to the system clipboard.
          </T>
        </p>
        {rc.ignored.length > 0 && (
          <ul className={styles.ignored} aria-label={tx("Ignored lines")}>
            {rc.ignored.map((i) => (
              <li key={`${i.file ?? ""}:${i.line}`}>
                <span className={styles.mono}>
                  {i.file ? `${i.file}:` : ""}
                  {i.line}: {i.text}
                </span>{" "}
                — {i.reason}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-label={tx("Shortcut conflicts")}>
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
        <p className={styles.hint}>
          <T>
            Ctrl+V pastes in Insert mode and starts a Visual block in Normal and Visual modes. Ctrl+C copies the
            selection in Visual mode and otherwise leaves the current mode.
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
                    aria-label={tx`Handler for ${r.stroke}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <Button size="small" onClick={() => setHandlers({})} disabled={!Object.keys(handlers).length}>
            Reset to Defaults
          </Button>
        </div>
      </section>
    </div>
  );
}
