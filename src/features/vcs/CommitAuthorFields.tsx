import { useId } from "react";
import { tx } from "@/platform/i18n";
import { IconButton, Input, T } from "@/ui";
import styles from "./CommitView.module.css";

function localDateInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function gitAuthorDate(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const offset = -date.getTimezoneOffset();
  const pad = (number: number) => String(number).padStart(2, "0");
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${localDateInput(date)}${offset < 0 ? "-" : "+"}${hours}:${minutes}`;
}

interface CommitAuthor {
  author: string;
  authorDate: string | null;
}

export function CommitAuthorFields({
  author,
  authorDate,
  preserveOriginal,
  focusAuthor,
  onChange,
}: CommitAuthor & {
  preserveOriginal: boolean;
  focusAuthor?: boolean;
  onChange: (update: Partial<CommitAuthor>) => void;
}) {
  const authorDateId = useId();
  const date = authorDate ? new Date(authorDate) : null;
  return (
    <>
      <label className={styles.optField}>
        <span>
          <T>Author:</T>
        </span>
        <Input
          value={author}
          title={tx(
            preserveOriginal
              ? "Use Name <email>. Leave blank to keep the original author."
              : "Name <email>; empty uses the configured Git user",
          )}
          aria-label="Author"
          data-autofocus={focusAuthor || undefined}
          autoSelect={focusAuthor}
          onChange={(e) => onChange({ author: e.target.value })}
        />
      </label>
      <div className={styles.optDate}>
        <label htmlFor={authorDateId}>
          <T>Author date</T>
        </label>
        <div className={styles.optDateInput}>
          <Input
            id={authorDateId}
            type="datetime-local"
            step={1}
            value={date && Number.isFinite(date.getTime()) ? localDateInput(date) : ""}
            title={tx(
              preserveOriginal
                ? "Leave blank to keep the original author date."
                : "Leave blank to use the current date and time.",
            )}
            onChange={(e) => onChange({ authorDate: gitAuthorDate(e.target.value) })}
          />
          {authorDate && (
            <IconButton
              icon="close"
              size="small"
              title="Clear author date"
              onClick={() => onChange({ authorDate: null })}
            />
          )}
        </div>
      </div>
    </>
  );
}
