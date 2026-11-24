import type { AgentEntry, AgentQuestion, AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { Button, Checkbox, Icon, Input, Radio, T, Tabs } from "@/ui";
import clsx from "clsx";
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { FormCard } from "../FormCard";
import styles from "../Session.module.css";
import {
  asksInCard,
  commandPrefix,
  permissionDetails,
  permissionOption,
  permissionResult,
  type PermissionEntry,
} from "../permission";
import { answerQuestion, respond } from "../store";
import { providerName, shortTitle } from "./shared";

/**
 * The answers to an open permission request. A request without options (some agents send
 * none) can still be cancelled, so the agent doesn't wait for an answer it can't get.
 */
function PermissionAnswers({
  task,
  entry,
  className,
}: {
  task: AgentTask;
  entry: PermissionEntry;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const { command } = permissionDetails(entry);
  const answer = (option: string | null) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    void respond(task.id, entry.id, option)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  return (
    <span className={className}>
      {entry.options.length ? (
        entry.options.map((o) => {
          const { label, variant } = permissionOption(o, !!command);
          return (
            <Button
              key={o.id}
              variant={variant}
              className={styles.permissionOption}
              size="small"
              aria-label={label}
              title={o.name}
              disabled={busy}
              onClick={() => answer(o.id)}
            >
              <span className={styles.permissionOptionLabel}>{label}</span>
            </Button>
          );
        })
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => answer(null)}>
          Cancel
        </Button>
      )}
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** A single inline decision, reduced to a compact record after it is answered. */
export function PermissionLine({ task, entry }: { task: AgentTask; entry: PermissionEntry }) {
  const tx = useTx();
  const ref = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const { title, detail, command } = permissionDetails(entry, providerName(task.provider));
  const result = permissionResult(entry);
  useLayoutEffect(() => {
    if (entry.chosen && hadFocus.current && document.activeElement === document.body)
      ref.current?.focus({ preventScroll: true });
  }, [entry.chosen]);
  return (
    <div
      ref={ref}
      role="region"
      aria-label={title}
      tabIndex={entry.chosen ? -1 : undefined}
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) hadFocus.current = false;
      }}
      className={clsx(styles.permissionLine, entry.chosen ? styles.permissionDone : styles.permissionAsking)}
    >
      <Icon name={!entry.chosen ? "warning" : result.allowed ? "check" : "minus"} size={14} />
      <div className={styles.permissionBody}>
        {entry.chosen ? (
          <span className={styles.permissionRecord} title={detail}>
            {result.label}:{" "}
            <span className={command ? styles.permissionPrefix : undefined}>
              {command ? commandPrefix(command) : shortTitle(task, detail)}
            </span>
          </span>
        ) : (
          <>
            <span className={styles.permissionTitle}>{title}</span>
            {command ? (
              <pre className={styles.permissionCommand} tabIndex={0} aria-label={tx("Command")}>
                <code>{command}</code>
              </pre>
            ) : (
              <span className={styles.permissionDetail}>{shortTitle(task, detail)}</span>
            )}
            {!asksInCard(entry) && <PermissionAnswers task={task} entry={entry} className={styles.permissionAnswers} />}
          </>
        )}
      </div>
    </div>
  );
}

export interface QuestionAnswer {
  question: AgentQuestion;
  picked: string[];
  /** The typed answer; `null` while "Other" isn't chosen. */
  other: string | null;
}

const answerItems = ({ picked, other }: QuestionAnswer) => [...picked, ...(other?.trim() ? [other.trim()] : [])];

const isAnswered = (answer: QuestionAnswer) => answerItems(answer).length > 0 && answer.other?.trim() !== "";

const RECOMMENDED_SUFFIX = " (Recommended)";

const isRecommended = (label: string) => label.endsWith(RECOMMENDED_SUFFIX);

const plainLabel = (label: string) => (isRecommended(label) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label);

type AsyncQuestionEntry = Extract<AgentEntry, { type: "question" }>;

/** Permission forms and questions that outlive their turn: pinned above the composer. */
export function QuestionCard({
  task,
  entries,
  drafts,
}: {
  task: AgentTask;
  entries: AgentEntry[] | null;
  drafts: RefObject<Map<string, QuestionAnswer[]>>;
}) {
  useEffect(() => {
    const open = new Set(
      entries
        ?.filter(
          (entry): entry is PermissionEntry | AsyncQuestionEntry =>
            (entry.type === "question" || entry.type === "permission") && !entry.chosen,
        )
        .map((entry) => `${entry.type}:${entry.id}`),
    );
    for (const key of drafts.current.keys()) if (!open.has(key)) drafts.current.delete(key);
  }, [entries]);
  if (task.status === "archived") return null;
  const entry =
    entries?.find(
      (candidate): candidate is PermissionEntry =>
        candidate.type === "permission" && !candidate.chosen && !!candidate.form,
    ) ??
    entries?.find((candidate): candidate is AsyncQuestionEntry => candidate.type === "question" && !candidate.chosen);
  if (entry?.type === "permission" && entry.form)
    return <FormCard key={entry.id} task={task} entry={entry} form={entry.form} />;
  return entry?.questions ? (
    <QuestionForm
      key={`${entry.type}:${entry.id}`}
      task={task}
      entry={entry}
      questions={entry.questions}
      drafts={drafts}
      pinned
    />
  ) : null;
}

export function QuestionForm({
  task,
  entry,
  questions,
  drafts,
  pinned = false,
}: {
  task: AgentTask;
  entry: PermissionEntry | AsyncQuestionEntry;
  questions: AgentQuestion[];
  drafts: RefObject<Map<string, QuestionAnswer[]>>;
  /** Above the composer rather than in the conversation. */
  pinned?: boolean;
}) {
  const cacheKey = `${entry.type}:${entry.id}`;
  const [answers, setAnswers] = useState<QuestionAnswer[]>(
    () =>
      drafts.current.get(cacheKey) ??
      questions.map((question) => ({ question, picked: [], other: question.options.length ? null : "" })),
  );
  useLayoutEffect(() => {
    drafts.current.set(cacheKey, answers);
  }, [drafts, cacheKey, answers]);
  const [position, setPosition] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const questionPrefix = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  // Paging with the buttons lands the keyboard focus on the question itself.
  const focusPanel = useRef(false);
  const multiple = answers.length > 1;
  const complete = answers.every(isAnswered);
  const last = position === answers.length - 1;
  const questionId = (part: string, index: number) => `${questionPrefix}-${part}-${index}`;
  useEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    panelRef.current?.focus();
  }, [position]);
  const send = (option: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const sent =
      entry.type === "question"
        ? answerQuestion(task.id, entry.id, option === "reject" ? null : option)
        : respond(task.id, entry.id, option);
    void sent
      .catch((error: unknown) => setError(String(error)))
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const submit = () =>
    send(
      JSON.stringify(
        Object.fromEntries(
          answers.map((answer) => [answer.question.answerKey ?? answer.question.question, answerItems(answer)]),
        ),
      ),
    );
  const update = (previous: QuestionAnswer, next: QuestionAnswer) =>
    setAnswers(answers.map((answer) => (answer === previous ? next : answer)));
  const goTo = (next: number, moveFocus = false) => {
    if (next < 0 || next >= answers.length) return;
    focusPanel.current = moveFocus;
    setPosition(next);
    setHovered(null);
  };
  const choose = (answer: QuestionAnswer, label: string, checked: boolean) => {
    update(
      answer,
      answer.question.multiSelect
        ? {
            ...answer,
            picked: checked ? [...answer.picked, label] : answer.picked.filter((picked) => picked !== label),
          }
        : { ...answer, picked: [label], other: null },
    );
    // Picking an option answers a single-select question in one go; answering it shows the next one.
    if (answer.question.multiSelect || isAnswered(answer) || last) return;
    goTo(position + 1, true);
  };
  const chooseOther = (answer: QuestionAnswer, checked: boolean) =>
    update(
      answer,
      answer.question.multiSelect ? { ...answer, other: checked ? "" : null } : { ...answer, picked: [], other: "" },
    );
  const chooseByNumber = (number: number) => {
    const answer = answers[position];
    if (!answer) return;
    const option = answer.question.options[number - 1];
    if (option) choose(answer, option.label, !answer.picked.includes(option.label));
    else if (number === answer.question.options.length + 1) chooseOther(answer, answer.other === null);
  };
  return (
    <form
      className={clsx(styles.questionCard, pinned && styles.questionCardPinned)}
      aria-label={entry.title}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) submit();
      }}
      onKeyDown={(event) => {
        const typing = event.target instanceof HTMLInputElement && event.target.type === "text";
        if (event.key === "Escape") send("reject");
        else if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/.test(event.key)) {
          event.preventDefault();
          chooseByNumber(Number(event.key));
        }
      }}
    >
      {multiple && (
        <div inert={busy}>
          <Tabs
            variant="compact"
            layout="squeeze"
            aria-label={entry.title}
            panelIdPrefix={questionPrefix}
            activeId={String(position)}
            onSelect={(id) => {
              if (!busy) goTo(Number(id));
            }}
            items={answers.map((item, index) => ({
              id: String(index),
              label: <span>{item.question.header?.trim() || item.question.question}</span>,
              text: item.question.header?.trim() || item.question.question,
              tooltip: item.question.question,
              trailing: isAnswered(item) ? (
                <Icon name="check" size={12} className={styles.questionTabCheck} />
              ) : undefined,
            }))}
          />
        </div>
      )}
      {/* All questions stay mounted in one grid cell, so the card keeps the tallest one's height. */}
      <div className={styles.questionPanels}>
        {answers.map((item, index) => {
          const current = index === position;
          const group = questionId("group", index);
          const hasPreviews = item.question.options.some((option) => option.preview);
          const targetLabel = (current ? hovered : null) ?? item.picked[0] ?? (item.other !== null ? group : undefined);
          const previewed =
            targetLabel === undefined
              ? item.question.options.find((option) => option.preview)
              : item.question.options.find((option) => option.label === targetLabel);
          const choices = [
            ...item.question.options.map((option) => ({
              key: option.label,
              checked: item.picked.includes(option.label),
              onChange: (checked: boolean) => choose(item, option.label, checked),
              label: (
                <span className={styles.questionOptionText}>
                  <span className={styles.questionLabel}>
                    {plainLabel(option.label)}
                    {isRecommended(option.label) && (
                      <span className={styles.questionTag}>
                        <T>Recommended</T>
                      </span>
                    )}
                  </span>
                  {option.description && <span className={styles.questionDescription}>{option.description}</span>}
                </span>
              ),
            })),
            {
              key: group,
              checked: item.other !== null,
              onChange: (checked: boolean) => chooseOther(item, checked),
              label: (
                <span className={styles.questionLabel}>
                  <T>Other</T>
                </span>
              ),
            },
          ];
          return (
            <div
              key={group}
              ref={current ? panelRef : undefined}
              role={multiple ? "tabpanel" : undefined}
              id={questionId("panel", index)}
              aria-labelledby={multiple ? questionId("tab", index) : undefined}
              aria-hidden={!current}
              inert={!current}
              tabIndex={multiple && current ? 0 : -1}
              className={clsx(styles.questionPanel, !current && styles.questionPanelHidden)}
            >
              <fieldset className={styles.question} disabled={busy}>
                <legend className={styles.questionText}>
                  {item.question.header && <span className={styles.questionTag}>{item.question.header}</span>}
                  {item.question.question}
                </legend>
                <div className={clsx(styles.questionBody, hasPreviews && styles.questionBodyWithPreview)}>
                  <div className={styles.questionChoices}>
                    {choices.map((choice, choiceIndex) => {
                      const label = (
                        <span className={styles.questionChoice}>
                          {choice.label}
                          <span className={styles.questionKey}>{choiceIndex + 1}</span>
                        </span>
                      );
                      return (
                        <div
                          key={choice.key}
                          onMouseEnter={() => setHovered(choice.key)}
                          onMouseLeave={() => setHovered(null)}
                        >
                          {item.question.multiSelect ? (
                            <Checkbox
                              className={styles.questionOption}
                              checked={choice.checked}
                              label={label}
                              onChange={choice.onChange}
                            />
                          ) : (
                            <Radio
                              className={styles.questionOption}
                              name={group}
                              checked={choice.checked}
                              label={label}
                              onChange={() => choice.onChange(true)}
                            />
                          )}
                        </div>
                      );
                    })}
                    {item.other !== null && (
                      <Input
                        autoFocus={entry.type === "permission" || item.question.options.length > 0}
                        className={styles.questionOther}
                        value={item.other}
                        placeholder="Type your answer"
                        onChange={(event) => update(item, { ...item, other: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && item.other) {
                            event.stopPropagation();
                            update(item, { ...item, other: "" });
                          }
                        }}
                      />
                    )}
                  </div>
                  {hasPreviews && (
                    <div className={styles.questionPreview}>
                      {[...item.question.options, null].map((option) => {
                        const shown = option === (previewed ?? null);
                        return (
                          <div
                            key={option?.label ?? group}
                            className={clsx(styles.questionPreviewItem, shown && styles.questionPreviewActive)}
                            aria-hidden={!shown}
                          >
                            <span className={styles.questionPreviewCaption}>
                              {option ? plainLabel(option.label) : <T>Other</T>}
                            </span>
                            {option?.preview ? (
                              <pre className={styles.questionPreviewBody}>{option.preview}</pre>
                            ) : (
                              <span className={styles.questionPreviewEmpty}>
                                <T>No preview</T>
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </fieldset>
            </div>
          );
        })}
      </div>
      <div className={styles.questionActions}>
        {error && (
          <span className={styles.error} role="alert">
            {error}
          </span>
        )}
        <Button variant="ghost" disabled={busy} onClick={() => send("reject")}>
          Skip
        </Button>
        {multiple && (
          <div className={styles.questionPager}>
            <Button size="small" disabled={busy || position === 0} onClick={() => goTo(position - 1, true)}>
              Previous
            </Button>
            <span className={styles.questionPage}>
              {position + 1} / {answers.length}
            </span>
            <Button
              size="small"
              disabled={busy || position === answers.length - 1}
              onClick={() => goTo(position + 1, true)}
            >
              Next
            </Button>
          </div>
        )}
        <Button type="submit" variant="primary" disabled={busy || !complete}>
          Submit
        </Button>
      </div>
    </form>
  );
}
