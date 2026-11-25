import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ApplyCommitOptions, ApplyCommitReview } from "@/bindings";
import { fontWeightOf } from "@/platform/editorSettings";
import { resolveMonoFont } from "@/platform/fonts";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { Button, Checkbox, Dialog, T } from "@/ui";
import { CommitAuthorFields } from "./CommitAuthorFields";
import { withChain, workingDiffData } from "./diffInput";
import { openDialog } from "./dialogs";
import { relTo } from "./model";
import styles from "./common.module.css";
import messageStyles from "./CommitMessageDialog.module.css";

type ApplyOptionsForm = {
  author: string;
  authorDate: string | null;
  signOff: boolean;
  runHooks: boolean;
};

export async function promptApplyCommitMessage(
  title: string,
  repo: string,
  review: ApplyCommitReview,
  draft?: ApplyCommitOptions,
): Promise<{ message: string; options: ApplyCommitOptions } | null> {
  let options: ApplyOptionsForm = {
    author: draft?.author?.trim() || review.author || "",
    authorDate: draft?.authorDate ?? review.authorDate ?? null,
    signOff: draft?.signOff ?? false,
    runHooks: draft?.runHooks ?? true,
  };
  const showDiff = async (index: number) => {
    const { openDiffDialog } = await import("./diffDialog");
    openDiffDialog(
      withChain(
        review.paths.map((path) => workingDiffData(path, undefined, "staged")),
        index,
      ),
    );
  };
  const message = await promptCommitMessage(
    title,
    tx("Commit message"),
    review.message,
    "Commit and Continue",
    <div className={messageStyles.review}>
      <div className={messageStyles.filesColumn}>
        <span className={messageStyles.label}>
          <T>Staged Changes</T>
        </span>
        <ul className={messageStyles.files} aria-label={tx("Staged Changes")}>
          {review.paths.map((path, index) => (
            <li key={path}>
              <Button
                size="small"
                variant="ghost"
                className={messageStyles.file}
                icon="diff"
                title="Show Diff"
                onClick={() => void showDiff(index)}
              >
                <span>{relTo(repo, path)}</span>
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <ApplyCommitFields
        initial={options}
        preserveOriginal={review.kind === "cherry-pick"}
        onChange={(next) => {
          options = next;
        }}
      />
    </div>,
  );
  if (message === null) return null;
  const author = options.author.trim();
  return {
    message,
    options: {
      ...options,
      author: !author || author === review.author ? null : author,
      authorDate: options.authorDate === review.authorDate ? null : options.authorDate,
    },
  };
}

function ApplyCommitFields({
  initial,
  preserveOriginal,
  onChange,
}: {
  initial: ApplyOptionsForm;
  preserveOriginal: boolean;
  onChange: (options: ApplyOptionsForm) => void;
}) {
  const [options, setOptions] = useState(initial);
  const update = (patch: Partial<ApplyOptionsForm>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    onChange(next);
  };
  return (
    <fieldset className={messageStyles.reviewOptions}>
      <legend className={messageStyles.label}>
        <T>Commit Options</T>
      </legend>
      <CommitAuthorFields
        author={options.author}
        authorDate={options.authorDate}
        preserveOriginal={preserveOriginal}
        onChange={update}
      />
      <Checkbox label="Sign-off commit" checked={options.signOff} onChange={(signOff) => update({ signOff })} />
      <Checkbox label="Run Git hooks" checked={options.runHooks} onChange={(runHooks) => update({ runHooks })} />
    </fieldset>
  );
}

export function promptCommitMessage(
  title: string,
  label: string,
  initial: string,
  okLabel = "OK",
  children?: ReactNode,
): Promise<string | null> {
  return new Promise((resolve) => {
    const close = openDialog(() => (
      <MessageDialog
        title={title}
        label={label}
        initial={initial}
        okLabel={okLabel}
        onDone={(m) => {
          close();
          resolve(m);
        }}
      >
        {children}
      </MessageDialog>
    ));
  });
}

function MessageDialog({
  title,
  label,
  initial,
  okLabel,
  onDone,
  children,
}: {
  title: string;
  label: string;
  initial: string;
  okLabel: string;
  onDone: (message: string | null) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState(initial);
  const editor = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(undefined, editor);
  useLayoutEffect(() => field.current?.setSelectionRange(0, 0), []);

  return (
    <Dialog
      open
      title={title}
      onClose={() => onDone(null)}
      width={620}
      minWidth={340}
      resizable="both"
      className={messageStyles.dialog}
      buttons={[
        { label: okLabel, role: "default", disabled: !message.trim(), onClick: () => onDone(message) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={messageStyles.form}>
        {children}
        <label className={messageStyles.label} htmlFor={id}>
          {label}
        </label>
        <textarea
          id={id}
          ref={field}
          data-autofocus
          className={`${styles.textarea} ${messageStyles.editor}`}
          style={{
            fontFamily: family,
            fontSize: size,
            fontWeight: fontWeightOf(editor?.fontWeight, 400),
            lineHeight: editor?.lineHeight ? `${editor.lineHeight}px` : undefined,
          }}
          rows={8}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
