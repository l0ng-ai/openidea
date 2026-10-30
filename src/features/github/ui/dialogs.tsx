/**
 * Promise-based dialogs of the GitHub feature, rendered by one overlay (`GithubDialogHost`):
 *
 *   const message = await mergeCommitMessageDialog({ title: "Merge Review", message });
 *
 * `openDialog` lets other parts add their own (it resolves with what `done` is given,
 * null when cancelled). Included: IntelliJ's merge commit message dialog, the pull request
 * number prompt of Git › GitHub › Checkout Pull Request…, and the quick Create Pull Request
 * dialog used until the New Pull Request tab is ported.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Checkbox, Dialog, Input, Select, T } from "@/ui";
import styles from "./ui.module.css";

interface Entry {
  id: number;
  node: ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

/** Shows `render(done)` until `done` is called; resolves with its value (null: cancelled). */
export function openDialog<T>(render: (done: (v: T | null) => void) => ReactNode): Promise<T | null> {
  return new Promise((resolve) => {
    const id = ++seq;
    const done = (v: T | null) => {
      useDialogs.setState((s) => ({ stack: s.stack.filter((e) => e.id !== id) }));
      resolve(v);
    };
    useDialogs.setState((s) => ({ stack: [...s.stack, { id, node: render(done) }] }));
  });
}

export function GithubDialogHost() {
  const stack = useDialogs((s) => s.stack);
  return (
    <>
      {stack.map((e) => (
        <Fragment key={e.id}>{e.node}</Fragment>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Merge commit message (`ReviewMergeCommitMessageDialog`)

/**
 * "Merge Review" / "Squash and Merge Review": the commit message to merge with (subject,
 * blank line, body); resolves with the edited message.
 */
export function mergeCommitMessageDialog(opts: { title: string; message: string }) {
  return openDialog<string>((done) => <MergeDialog {...opts} onDone={done} />);
}

function MergeDialog(props: { title: string; message: string; onDone: (v: string | null) => void }) {
  const [message, setMessage] = useState(props.message);
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={540}
      buttons={[
        { label: "Merge", role: "default", disabled: !message.trim(), onClick: () => props.onDone(message) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.fieldLabel}>
          <T>Merge commit message:</T>
        </label>
        <textarea
          data-autofocus
          aria-label={tx("Merge commit message")}
          className={styles.textarea}
          style={{ minHeight: 85 }}
          rows={6}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pull request number

/** Asks for a pull request number (Git › GitHub › Checkout Pull Request…). */
export function numberDialog(title: string) {
  return openDialog<number>((done) => <NumberDialog title={title} onDone={done} />);
}

function NumberDialog(props: { title: string; onDone: (v: number | null) => void }) {
  const [value, setValue] = useState("");
  const n = Number.parseInt(value.replace(/^#/, ""), 10);
  const ok = Number.isInteger(n) && n > 0;
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={360}
      buttons={[
        { label: "OK", role: "default", disabled: !ok, onClick: () => props.onDone(n) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onDone(n);
        }}
      >
        <label className={styles.fieldLabel}>
          <T>Pull request number:</T>
        </label>
        <Input
          data-autofocus
          mono
          aria-label="Pull request number"
          placeholder="#123"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Quick Create Pull Request (gh pr create)

export interface CreatePrInput {
  title: string;
  body: string;
  base: string;
  draft: boolean;
  push: boolean;
}

/** Asks for the new pull request's title, description, base branch and options. */
export function createPullRequestDialog(opts: {
  head: string;
  defaultBase: string | null;
  title: string;
  needsPush: boolean;
}) {
  return openDialog<CreatePrInput>((done) => <CreateDialog {...opts} onDone={done} />);
}

function CreateDialog(props: {
  head: string;
  defaultBase: string | null;
  title: string;
  needsPush: boolean;
  onDone: (v: CreatePrInput | null) => void;
}) {
  const [title, setTitle] = useState(props.title);
  const [body, setBody] = useState("");
  const [base, setBase] = useState(props.defaultBase ?? "");
  const [bases, setBases] = useState<string[]>(props.defaultBase ? [props.defaultBase] : []);
  const [draft, setDraft] = useState(false);
  const [push, setPush] = useState(props.needsPush);

  useEffect(() => {
    let alive = true;
    // Base candidates: branches of the remotes (without `origin/`), the default first.
    call(commands.vcsBranches(null))
      .then((branches) => {
        const names = new Set<string>();
        if (props.defaultBase) names.add(props.defaultBase);
        for (const b of branches) {
          if (!b.remote || b.name.endsWith("/HEAD")) continue;
          const short = b.name.slice(b.name.indexOf("/") + 1);
          if (short !== props.head) names.add(short);
        }
        if (alive) {
          setBases([...names]);
          setBase((cur) => cur || [...names][0] || "");
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [props.defaultBase, props.head]);

  const ok = !!title.trim() && !!base;
  const submit = () => ok && props.onDone({ title: title.trim(), body, base, draft, push });
  return (
    <Dialog
      open
      title="Create Pull Request"
      onClose={() => props.onDone(null)}
      width={560}
      buttons={[
        { label: draft ? "Create Draft" : "Create", role: "default", disabled: !ok, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.formRow}>
          <label className={styles.fieldLabel}>
            <T>Base:</T>
          </label>
          <Select
            value={base || null}
            options={bases.map((b) => ({ value: b, label: b }))}
            onChange={setBase}
            aria-label="Base branch"
          />
          <span className={styles.fieldLabel}>← {props.head}</span>
        </div>
        <Input
          data-autofocus
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          aria-label={tx("Description")}
          placeholder={tx("Description (Markdown)")}
          className={styles.textarea}
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className={styles.formRow}>
          <Checkbox checked={draft} onChange={setDraft} label="Draft" />
          <Checkbox checked={push} onChange={setPush} label={tx`Push '${props.head}' first`} />
        </div>
      </div>
    </Dialog>
  );
}
