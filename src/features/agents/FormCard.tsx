import { useId, useState } from "react";
import type { AgentForm, AgentFormField, AgentTask } from "@/bindings";
import { Button, Checkbox, Input, Radio, T } from "@/ui";
import type { PermissionEntry } from "./permission";
import { respond } from "./store";
import styles from "./Session.module.css";

/** Each field's answer as the backend reads it: option values, a text, a number, or `true` / `false`. */
type Values = Record<string, string[]>;

const within = (field: AgentFormField, n: number) =>
  (field.min == null || n >= field.min) && (field.max == null || n <= field.max);

function isValid(field: AgentFormField, value: string[]) {
  const given = value.map((item) => item.trim()).filter(Boolean);
  if (!given.length) return !field.required;
  switch (field.kind) {
    case "number":
    case "integer": {
      const n = Number(given[0]);
      return Number.isFinite(n) && (field.kind === "number" || Number.isInteger(n)) && within(field, n);
    }
    case "text":
      return within(field, given[0]!.length);
    case "choices":
      return within(field, given.length);
    default:
      return true;
  }
}

/** An agent's open form (ACP elicitation), answered above the composer like a question. */
export function FormCard({ task, entry, form }: { task: AgentTask; entry: PermissionEntry; form: AgentForm }) {
  const [values, setValues] = useState<Values>(() =>
    Object.fromEntries(
      form.fields.map((field) => [
        field.name,
        field.kind === "boolean" ? [String(field.default?.[0] === "true")] : (field.default ?? []),
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const complete = form.fields.every((field) => isValid(field, values[field.name] ?? []));
  // `decline` declines the form, nothing cancels it, and the values accept it.
  const send = (reply: string | null) => {
    setBusy(true);
    void respond(task.id, entry.id, reply).finally(() => setBusy(false));
  };
  return (
    <form
      className={styles.questionCard}
      aria-label={entry.title}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) send(JSON.stringify(values));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") send(null);
      }}
    >
      {/* A one-question form often titles its field with the message; it is shown once, as the field's. */}
      {entry.title && !form.fields.some((field) => field.title === entry.title) && (
        <p className={styles.formMessage}>{entry.title}</p>
      )}
      <fieldset className={styles.formFields} disabled={busy}>
        {form.fields.map((field) => (
          <FormField
            key={field.name}
            field={field}
            value={values[field.name] ?? []}
            onChange={(value) => setValues({ ...values, [field.name]: value })}
          />
        ))}
      </fieldset>
      <div className={styles.questionActions}>
        <Button variant="ghost" disabled={busy} onClick={() => send(null)}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => send("decline")}>
          Decline
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !complete}>
          Submit
        </Button>
      </div>
    </form>
  );
}

function FormField({
  field,
  value,
  onChange,
}: {
  field: AgentFormField;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const title = (
    <>
      {field.title}
      {field.required && (
        <span className={styles.questionTag}>
          <T>Required</T>
        </span>
      )}
    </>
  );
  const description = field.description && <span className={styles.questionDescription}>{field.description}</span>;
  const optionLabel = (label: string, about?: string) => (
    <span className={styles.questionOptionText}>
      <span className={styles.questionLabel}>{label}</span>
      {about && <span className={styles.questionDescription}>{about}</span>}
    </span>
  );
  if (field.kind === "boolean") {
    return (
      <div className={styles.question}>
        <div className={styles.questionChoices}>
          <Checkbox
            className={styles.questionOption}
            checked={value[0] === "true"}
            label={optionLabel(field.title, field.description)}
            onChange={(checked) => onChange([String(checked)])}
          />
        </div>
      </div>
    );
  }
  if (field.kind === "choice" || field.kind === "choices") {
    return (
      <fieldset className={styles.question}>
        <legend className={styles.questionText}>{title}</legend>
        {description}
        <div className={styles.questionChoices}>
          {(field.options ?? []).map((option) =>
            field.kind === "choices" ? (
              <Checkbox
                key={option.value}
                className={styles.questionOption}
                checked={value.includes(option.value)}
                label={optionLabel(option.label, option.description)}
                onChange={(checked) =>
                  onChange(checked ? [...value, option.value] : value.filter((v) => v !== option.value))
                }
              />
            ) : (
              <Radio
                key={option.value}
                className={styles.questionOption}
                name={id}
                checked={value[0] === option.value}
                label={optionLabel(option.label, option.description)}
                onChange={() => onChange([option.value])}
              />
            ),
          )}
        </div>
      </fieldset>
    );
  }
  const numeric = field.kind !== "text";
  return (
    <div className={styles.question}>
      <label className={styles.questionText} htmlFor={id}>
        {title}
      </label>
      <Input
        id={id}
        type={numeric ? "number" : "text"}
        inputMode={field.kind === "integer" ? "numeric" : numeric ? "decimal" : undefined}
        step={field.kind === "integer" ? 1 : numeric ? "any" : undefined}
        min={numeric ? (field.min ?? undefined) : undefined}
        max={numeric ? (field.max ?? undefined) : undefined}
        maxLength={numeric ? undefined : (field.max ?? undefined)}
        invalid={value.some((item) => item.trim()) && !isValid(field, value)}
        value={value[0] ?? ""}
        onChange={(event) => onChange([event.target.value])}
      />
    </div>
  );
}
