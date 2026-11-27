import { Channel } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import type {
  HistoryTip,
  RebaseOptions,
  RebaseEditorOperation,
  RebaseEditorPrompt,
  RebaseEditorReply,
  RebaseState,
  RequestId,
} from "@/bindings";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Dialog } from "@/ui";
import { openDialog } from "./dialogs";
import { errorMessage, runGitOperationWith, type GitOperationOptions } from "./ops";
import { RebasePlanDialog, useCloseRebasePlan } from "./RebasePlanDialog";
import { nativePlanProblem, nativePlanReply, nativePlanRows } from "./rebasePlan";
import { currentRepo } from "./store";
import styles from "./common.module.css";

export function runRebaseWithEditor(
  repo: string | null,
  upstream: string | null,
  options: RebaseOptions,
  operation: GitOperationOptions,
) {
  return runWithEditor("rebase --interactive", { kind: "start", upstream, options }, operation, repo);
}

export function resumeRebaseWithEditor(
  control: "continue" | "stageAndContinue" | "skip",
  options: GitOperationOptions,
  repo = currentRepo(),
  session?: { state: RebaseState; record: (head: HistoryTip) => void },
) {
  if (control === "skip") return runWithEditor("rebase --skip", { kind: "skip" }, options, repo, session);
  const stage = control === "stageAndContinue";
  return runWithEditor(
    stage ? "add -u && rebase --continue" : "rebase --continue",
    { kind: "continue", stage },
    options,
    repo,
    session,
  );
}

function runWithEditor(
  description: string,
  operation: RebaseEditorOperation,
  options: GitOperationOptions,
  repo: string | null,
  session?: { state: RebaseState; record: (head: HistoryTip) => void },
) {
  return runGitOperationWith(description, options, async ({ request, output }) => {
    const edits = new Channel<RebaseEditorPrompt>();
    let closeEditor: (() => void) | undefined;
    edits.onmessage = (prompt) => {
      closeEditor?.();
      closeEditor = openDialog((close) => <RebaseEditor repo={repo} request={request} prompt={prompt} close={close} />);
    };
    try {
      const head = await call(
        commands.vcsRebaseWithEditor(repo, operation, request, output(), edits, session?.state ?? null),
      );
      if (session && head) session.record(head);
      return null;
    } finally {
      closeEditor?.();
    }
  });
}

function RebaseEditor({
  repo,
  request,
  prompt,
  close,
}: {
  repo: string | null;
  request: RequestId;
  prompt: RebaseEditorPrompt;
  close: () => void;
}) {
  const [draft, setDraft] = useState<RebaseEditorReply | null>(prompt.edit.plan ? null : { text: prompt.edit.text });
  const [problem, setProblem] = useState<string | null>(null);
  const sending = useRef(false);
  const plan = prompt.edit.kind === "plan";
  const reply = async (value: RebaseEditorReply | null) => {
    if (sending.current) return;
    sending.current = true;
    try {
      await call(commands.vcsRebaseEditorReply(request, prompt.index, value));
      close();
    } catch (error) {
      setProblem(errorMessage(error));
      sending.current = false;
    }
  };
  const initialPlan = prompt.edit.plan;
  const closeRaw = useCloseRebasePlan(
    plan &&
      draft !== null &&
      (draft.text !== prompt.edit.text ||
        !!initialPlan?.some(
          (row) =>
            row.kind === "commit" && draft.rewords?.[row.id] !== undefined && draft.rewords[row.id] !== row.message,
        )),
    () => void reply(null),
  );
  if (draft === null && initialPlan) {
    return (
      <RebasePlanDialog
        repo={repo}
        title={tx("Edit Git Rebase Plan")}
        initial={nativePlanRows(initialPlan)}
        validate={nativePlanProblem}
        replyProblem={problem}
        onClose={() => void reply(null)}
        onStart={(rows) => void reply(nativePlanReply(prompt.edit.text, initialPlan, rows))}
        onEditText={(rows) => setDraft(nativePlanReply(prompt.edit.text, initialPlan, rows))}
      />
    );
  }

  return (
    <Dialog
      open
      title={plan ? tx("Edit Git Rebase Plan") : tx("Edit Commit Message")}
      onClose={closeRaw}
      width={plan ? 780 : 520}
      buttons={[
        {
          label: plan ? "Start Rebasing" : "Save Commit Message",
          role: "default",
          onClick: () => void reply(draft),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <textarea
          data-autofocus
          aria-label={plan ? tx("Git rebase plan") : tx("Commit message")}
          className={plan ? `${styles.textarea} ${styles.rebaseTodo}` : styles.textarea}
          rows={plan ? 18 : 8}
          wrap={plan ? "off" : "soft"}
          spellCheck={!plan}
          value={draft?.text ?? ""}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        />
        {problem && <div className={styles.error}>{problem}</div>}
      </div>
    </Dialog>
  );
}
