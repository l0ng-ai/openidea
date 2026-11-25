/**
 * Editor-area tab of one terminal session (#2202, Move to Editor): the session's xterm
 * while it runs, else a Start screen — a tab restored with the project never starts on
 * its own. The session lives in `cliSessions.ts`; this only attaches its host while the
 * tab is the one shown.
 */
import { useEffect, useLayoutEffect, useRef, type FocusEvent } from "react";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { useEditorShown, type EditorInput } from "@/workbench/contributions";
import { Button, EmptyState, T } from "@/ui";
import { cliData, reattachCliTab, startTab, useClis } from "./cli";
import { cliSession } from "./cliSessions";
import styles from "./Cli.module.css";
// The pane is the terminal tool window's own: same xterm layout, cursor and scrollbar.
import terminalStyles from "./Terminal.module.css";

export function CliEditor({ input }: { input: EditorInput }) {
  const data = cliData(input);
  const live = useClis((s) => !!s.sessions[input.key]);
  const shown = useEditorShown();
  const project = useProject((s) => s.project);
  const remote = useRemote((s) => s.session !== null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live && remote && project?.root && data?.terminalId) {
      void reattachCliTab(input);
    }
  }, [live, remote, project?.root, data?.terminalId, input]);

  // Hidden tabs stay unopened (xterm opened at 0×0 never takes keys); the session keeps running.
  useLayoutEffect(() => {
    const el = ref.current;
    const session = cliSession(input.key);
    if (!el || !session || !shown) return;
    session.attach(el);
    // The editor focuses the tab wrapper ([data-editor-focus]); hand focus on to xterm.
    const wrapper = el.closest<HTMLElement>("[data-editor-focus]");
    const onFocus = () => session.focus();
    wrapper?.addEventListener("focus", onFocus);
    return () => {
      wrapper?.removeEventListener("focus", onFocus);
      session.detach(el);
    };
  }, [input.key, live, shown]);

  if (!data) return <EmptyState icon="terminal" title="Terminal" />;
  if (!live)
    return (
      <div className={styles.start}>
        <div className={styles.startInner}>
          <h1 className={styles.heading}>{data.name}</h1>
          {data.command && <pre className={styles.command}>{data.command}</pre>}
          <p className={styles.note}>
            <T>Starts a login shell where the session was.</T>
          </p>
          <Button variant="primary" disabled={!project?.root} onClick={() => void startTab(input)}>
            <T>Start</T>
          </Button>
        </div>
      </div>
    );
  return (
    <div
      ref={ref}
      className={terminalStyles.pane}
      tabIndex={-1}
      onFocus={(e: FocusEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) cliSession(input.key)?.focus();
      }}
    />
  );
}
