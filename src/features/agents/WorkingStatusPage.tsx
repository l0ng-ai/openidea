/**
 * Settings › Agents › Working Status: whether the status under a conversation turns playful, after
 * how long without news, and the playful words of each activity, the built-in ones until the user
 * writes their own.
 */
import { useId, useState } from "react";
import { useTx } from "@/platform/i18n";
import { PLAYFUL_AFTER_LIMITS } from "@/platform/agentStatus";
import { Button, Checkbox, IconButton, Input, Select, T, type SelectOption } from "@/ui";
import { useSettingsForm } from "@/workbench/contributions";
import { AGENT_SETTINGS_DEFAULTS } from "./agentSettings";
import { ACTIVITIES, ACTIVITY_STATUS, PLAYFUL_WORDS, type Activity } from "./workingStatus";
import styles from "./WorkingStatus.module.css";

export function WorkingStatusPage() {
  const tx = useTx();
  const form = useSettingsForm();
  const playful =
    (form.useValue("agents.playfulStatus") as boolean | undefined) ?? AGENT_SETTINGS_DEFAULTS.playfulStatus;
  const own = (form.useValue("agents.playfulWords") ?? {}) as Record<string, string[]>;
  const [activity, setActivity] = useState<Activity>("working");
  const [draft, setDraft] = useState("");
  const selectId = useId();
  const custom = own[activity];
  const words = custom ?? PLAYFUL_WORDS[activity].map((w) => tx(w));

  const options: SelectOption<Activity>[] = ACTIVITIES.map((a) => ({
    value: a,
    label: ACTIVITY_STATUS[a],
    detail: own[a] ? "Custom" : undefined,
  }));
  const setWords = (next: string[] | null) => {
    const others = Object.fromEntries(Object.entries(own).filter(([a]) => a !== activity));
    form.set("agents.playfulWords", next ? { ...others, [activity]: next } : others);
  };
  const add = () => {
    const word = draft.trim();
    if (!word) return;
    setDraft("");
    if (!words.includes(word)) setWords([...words, word]);
  };

  return (
    <section className={styles.body} aria-label={tx("Working Status")}>
      <p className={styles.notice}>
        <T>
          While the agent works, the line under the conversation says what it is doing. With playful words on, words for
          what it does take turns there instead, from the start or once it reports nothing new for a while; screen
          readers still hear the plain status.
        </T>
      </p>
      <Checkbox
        checked={playful}
        onChange={(on) => form.set("agents.playfulStatus", on)}
        label="Playful words while the agent works"
      />
      <PlayfulAfter disabled={!playful} />
      <div className={styles.activity}>
        <label htmlFor={selectId}>
          <T>While the status says</T>
        </label>
        <Select id={selectId} value={activity} options={options} onChange={setActivity} disabled={!playful} />
      </div>
      <div className={styles.items} role="list" aria-label={tx("Playful words")}>
        {words.length === 0 && (
          <div className={styles.empty}>
            <T>No playful words: the status stays factual</T>
          </div>
        )}
        {words.map((word, i) => (
          <div key={`${i}:${word}`} className={styles.item} role="listitem">
            <span className={styles.word}>{word}</span>
            <IconButton
              icon="close"
              size="small"
              title={tx`Remove ${word}`}
              disabled={!playful}
              onClick={() => setWords(words.filter((_, j) => j !== i))}
            />
          </div>
        ))}
      </div>
      <div className={styles.add}>
        <input
          type="text"
          className={styles.input}
          value={draft}
          disabled={!playful}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // Enter adds the word; it does not press the dialog's OK.
            e.preventDefault();
            add();
          }}
          placeholder={tx("e.g. Reticulating splines…")}
          aria-label={tx("New playful word")}
        />
        <Button size="small" disabled={!playful} onClick={add}>
          Add
        </Button>
        <Button size="small" disabled={!playful || !custom} onClick={() => setWords(null)}>
          Restore Built-in Words
        </Button>
      </div>
    </section>
  );
}

/** Seconds without news before the status turns playful; invalid text is flagged and reverted on blur. */
function PlayfulAfter({ disabled }: { disabled: boolean }) {
  const tx = useTx();
  const form = useSettingsForm();
  const value =
    (form.useValue("agents.playfulAfterSeconds") as number | undefined) ?? AGENT_SETTINGS_DEFAULTS.playfulAfterSeconds;
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const { min, max } = PLAYFUL_AFTER_LIMITS;
  const parse = (text: string) => {
    const n = /^\s*\d+\s*$/.test(text) ? Number(text) : NaN;
    return n >= min && n <= max ? n : null;
  };
  const invalid = draft !== null && parse(draft) === null;
  return (
    <div className={styles.after}>
      <label htmlFor={id}>
        <T>Start after the agent reports nothing new for</T>
      </label>
      <Input
        id={id}
        className={styles.seconds}
        inputMode="numeric"
        value={draft ?? String(value)}
        invalid={invalid}
        disabled={disabled}
        title={invalid ? tx`Enter a value between ${min} and ${max}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parse(e.target.value);
          if (n !== null) form.set("agents.playfulAfterSeconds", n);
        }}
        onBlur={() => setDraft(null)}
      />
      <T>seconds</T>
    </div>
  );
}
