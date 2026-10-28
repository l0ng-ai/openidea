/** Create Pull Request, Submit Review and Checkout-by-number dialogs, rendered by one overlay. */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { create } from "zustand";
import type { ReviewEvent } from "@/platform/ipc";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, Input, Select, T } from "@/ui";
import styles from "./Github.module.css";
import { tx } from "@/platform/i18n";

interface Entry {
  id: number;
  node: ReactNode;
}

const useDialogs = create<{ stack: Entry[] }>(() => ({ stack: [] }));
let seq = 0;

function open<T>(render: (done: (v: T | null) => void) => ReactNode): Promise<T | null> {
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
  return open<CreatePrInput>((done) => <CreateDialog {...opts} onDone={done} />);
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

const REVIEW_LABEL: Record<ReviewEvent, string> = {
  approve: "Approve",
  requestChanges: "Request Changes",
  comment: "Comment",
};

/** Asks for a review comment; resolves with the chosen event and body. */
export function reviewDialog(number: number, initial: ReviewEvent) {
  return open<{ event: ReviewEvent; body: string }>((done) => (
    <ReviewDialog number={number} initial={initial} onDone={done} />
  ));
}

function ReviewDialog(props: {
  number: number;
  initial: ReviewEvent;
  onDone: (v: { event: ReviewEvent; body: string } | null) => void;
}) {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ReviewEvent>(props.initial);
  const needsBody = event !== "approve";
  return (
    <Dialog
      open
      title={tx`Review #${props.number}`}
      onClose={() => props.onDone(null)}
      width={520}
      buttons={[
        {
          label: REVIEW_LABEL[event],
          role: "default",
          disabled: needsBody && !body.trim(),
          onClick: () => props.onDone({ event, body }),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <Select<ReviewEvent>
          value={event}
          onChange={setEvent}
          aria-label="Review action"
          options={(Object.keys(REVIEW_LABEL) as ReviewEvent[]).map((v) => ({ value: v, label: REVIEW_LABEL[v] }))}
        />
        <textarea
          data-autofocus
          aria-label={tx("Review comment")}
          placeholder={needsBody ? tx("Leave a comment (required)") : tx("Leave a comment (optional)")}
          className={styles.textarea}
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

/** Asks for a pull request number (Git › GitHub › Checkout Pull Request…). */
export function numberDialog(title: string) {
  return open<number>((done) => <NumberDialog title={title} onDone={done} />);
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
