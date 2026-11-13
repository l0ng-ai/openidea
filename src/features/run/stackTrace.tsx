/**
 * Code › Analyze Stack Trace or Thread Dump…: paste a trace (prefilled from
 * the clipboard) and browse it in a console whose frames link to the sources,
 * using the run console's link parser and navigation. Like IDEA, each trace
 * is a tab of the Run tool window, next to the run sessions.
 */
import { useState } from "react";
import { create } from "zustand";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { registerOverlay, toolWindowService } from "@/workbench/contributions";
import { Dialog, T } from "@/ui";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";
import { findOutputLinks } from "./links";
import { useRun } from "./store";
import styles from "./StackTrace.module.css";
import { tx } from "@/platform/i18n";
import { readClipboardPlainText } from "@/platform/clipboard";

export interface StackTraceTab {
  id: string;
  title: string;
  model: ConsoleModel;
}

interface StackTraceState {
  tabs: StackTraceTab[];
  /** Text of the open "Analyze Stack Trace" dialog, or null when closed. */
  dialog: string | null;
}

export const useStackTraces = create<StackTraceState>(() => ({ tabs: [], dialog: null }));

let seq = 0;

/** Normalises pasted text: line endings, trailing blanks, surrounding empty lines. */
export function normalizeTrace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Tab title: the exception (or first) line, shortened. */
export function traceTitle(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const head =
    lines.find((l) => /(Exception|Error|panicked|Traceback|^Full thread dump)/.test(l) && !/^at\s/.test(l)) ??
    lines[0] ??
    "Stack trace";
  // `java.lang.IllegalStateException: boom` → `IllegalStateException`
  const m = /^(?:Exception in thread "[^"]*"\s+)?(?:[\w$]+\.)*([\w$]+(?:Exception|Error))\b/.exec(head);
  const title = m ? m[1]! : head;
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

/** Number of lines in `text` with a clickable source location. */
export function countFrames(text: string): number {
  return text.split("\n").filter((l) => findOutputLinks(l).some((k) => k.kind === "file")).length;
}

export function addStackTrace(raw: string): string | null {
  const text = normalizeTrace(raw);
  if (!text) return null;
  const model = new ConsoleModel();
  model.append({ kind: "stdout", text });
  model.flush();
  const id = `trace-${++seq}`;
  useStackTraces.setState((s) => ({ tabs: [...s.tabs, { id, title: traceTitle(text), model }] }));
  useRun.setState({ activeSession: id });
  return id;
}

export function closeStackTrace(id: string) {
  useStackTraces.setState((s) => ({ tabs: s.tabs.filter((t) => t.id !== id) }));
}

async function openDialog() {
  let clip = "";
  try {
    clip = await readClipboardPlainText();
  } catch {
    // clipboard unavailable or denied: start empty
  }
  useStackTraces.setState({ dialog: countFrames(normalizeTrace(clip)) > 0 ? clip : "" });
}

function StackTraceDialogOverlay() {
  const initial = useStackTraces((s) => s.dialog);
  if (initial === null) return null;
  return <StackTraceDialog initial={initial} />;
}

function StackTraceDialog({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const close = () => useStackTraces.setState({ dialog: null });
  const ok = () => {
    if (!addStackTrace(text)) return;
    close();
    toolWindowService().show("run", true);
  };
  return (
    <Dialog
      open
      title="Analyze Stack Trace"
      onClose={close}
      width={720}
      buttons={[
        { label: "Analyze", role: "default", disabled: !text.trim(), onClick: ok },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.label} htmlFor="stacktrace-text">
          <T>Put a stack trace or a complete thread dump here:</T>
        </label>
        <textarea
          id="stacktrace-text"
          className={styles.text}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-autofocus=""
        />
      </div>
    </Dialog>
  );
}

/** A trace tab's console in the Run tool window. */
export function StackTracePanel({ tab }: { tab: StackTraceTab }) {
  const root = useProject((s) => s.project?.root ?? "/");
  return (
    <ConsoleView
      model={tab.model}
      version={tab.model.size}
      softWrap={false}
      follow={false}
      onFollowChange={() => {}}
      cwd={root}
      aria-label={tx`Stack trace ${tab.title}`}
    />
  );
}

export function activateStackTrace(): () => void {
  const disposers = [
    registerOverlay({ id: "run.stackTraceDialog", component: StackTraceDialogOverlay }),
    registerActions([
      {
        id: "analyze.stackTrace",
        title: "Analyze Stack Trace or Thread Dump…",
        category: "Code",
        when: "projectOpen",
        keywords: ["stacktrace", "exception", "thread dump", "unscramble"],
        run: () => void openDialog(),
      },
    ]),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
