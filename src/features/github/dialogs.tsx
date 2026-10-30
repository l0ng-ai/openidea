/** Create Pull Request, Submit Review, Merge, Request Review and Checkout-by-number dialogs, rendered by one overlay. */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
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

/** IDEA's merge commit message dialog: the message to merge (or squash and merge) with. */
export function mergeDialog(opts: { title: string; number: number; subject: string; body: string; ok: string }) {
  return open<{ subject: string; body: string }>((done) => <MergeDialog {...opts} onDone={done} />);
}

function MergeDialog(props: {
  title: string;
  number: number;
  subject: string;
  body: string;
  ok: string;
  onDone: (v: { subject: string; body: string } | null) => void;
}) {
  const [subject, setSubject] = useState(props.subject);
  const [body, setBody] = useState(props.body);
  return (
    <Dialog
      open
      title={props.title}
      onClose={() => props.onDone(null)}
      width={560}
      buttons={[
        { label: props.ok, role: "default", onClick: () => props.onDone({ subject, body }) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <label className={styles.fieldLabel}>{tx`Commit message for #${props.number}:`}</label>
        <Input
          data-autofocus
          aria-label="Commit subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <textarea
          aria-label={tx("Commit description")}
          className={styles.textarea}
          rows={8}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
    </Dialog>
  );
}

/** Asks whom to request a review from; resolves with the chosen logins. */
export function reviewersDialog(opts: { number: number; load: () => Promise<string[]>; exclude: readonly string[] }) {
  return open<string[]>((done) => <ReviewersDialog {...opts} onDone={done} />);
}

function ReviewersDialog(props: {
  number: number;
  load: () => Promise<string[]>;
  exclude: readonly string[];
  onDone: (v: string[] | null) => void;
}) {
  const [users, setUsers] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const { load, exclude } = props;
  useEffect(() => {
    let alive = true;
    load()
      .then((all) => alive && setUsers(all.filter((u) => !exclude.includes(u))))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [load, exclude]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (users ?? []).filter((u) => !f || u.toLowerCase().includes(f));
  }, [users, filter]);
  const toggle = (u: string, on: boolean) =>
    setChosen((cur) => {
      const next = new Set(cur);
      if (on) next.add(u);
      else next.delete(u);
      return next;
    });
  return (
    <Dialog
      open
      title={tx`Request Review on #${props.number}`}
      onClose={() => props.onDone(null)}
      width={400}
      buttons={[
        {
          label: "Request Review",
          role: "default",
          disabled: chosen.size === 0,
          onClick: () => props.onDone([...chosen]),
        },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <Input
          data-autofocus
          aria-label="Filter reviewers"
          placeholder="Filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className={styles.reviewerList} role="group" aria-label={tx("Reviewers")}>
          {error ? (
            <div className={styles.error}>{error}</div>
          ) : users === null ? (
            <div className={styles.dim}>
              <T>Loading…</T>
            </div>
          ) : shown.length === 0 ? (
            <div className={styles.dim}>
              <T>No users to request a review from</T>
            </div>
          ) : (
            shown.map((u) => (
              <Checkbox key={u} checked={chosen.has(u)} onChange={(on) => toggle(u, on)} label={<span>{u}</span>} />
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
