/**
 * Editor-area tab of one CLI (#2202): the session's xterm while it runs, else a
 * Start screen — a tab restored with the project never runs its command on its
 * own. The session lives in `cliSessions.ts`; this only attaches its host while
 * the tab is the one shown.
 */
import { useLayoutEffect, useRef, type FocusEvent } from "react";
import { useProject } from "@/platform/project";
import { useEditorShown, type EditorInput } from "@/workbench/contributions";
import { Button, EmptyState, T } from "@/ui";
import { cliData, startTab, useClis } from "./cli";
import { cliSession } from "./cliSessions";
import styles from "./Cli.module.css";
// The pane is the terminal tool window's own: same xterm layout, cursor and scrollbar.
import terminalStyles from "./Terminal.module.css";

export function CliEditor({ input }: { input: EditorInput }) {
  const data = cliData(input);
  const live = useClis((s) => !!s.sessions[input.key]);
  const shown = useEditorShown();
  const project = useProject((s) => s.project);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!data) return <EmptyState icon="terminal" title="CLI" />;
  if (!live)
    return (
      <div className={styles.start}>
        <div className={styles.startInner}>
          <h1 className={styles.heading}>{data.name}</h1>
          {data.command && <pre className={styles.command}>{data.command}</pre>}
          <p className={styles.note}>
            <T>Starts in the project directory through your login shell.</T>
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
