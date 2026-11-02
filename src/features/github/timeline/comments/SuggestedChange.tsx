/**
 * A review comment's body with its suggested changes (`GHPRReviewCommentBodyComponentFactory`,
 * `GHPRReviewSuggestedChangeComponentFactory`): Markdown parts as they are, each
 * ```` ```suggestion ```` block as a rounded "Suggested change" box with the diff from the
 * commented code to the suggestion and the "Apply Locally" option button with "Commit…".
 * The button is disabled, with IntelliJ's tooltip, for resolved and outdated threads and
 * when the pull request's branch is not checked out.
 */
import { useState } from "react";
import { useTx } from "@/platform/i18n";
import { Button, Icon, Menu, Popup, tooltipAttrs } from "@/ui";
import type { GHPullRequestReviewThread } from "../../api/types";
import { Markdown } from "../../ui/Markdown";
import {
  splitSuggestions,
  suggestionDisabledReason,
  suggestionTarget,
  threadDiffHunk,
  type PatchHunk,
  type SuggestionTarget,
} from "../model";
import { HunkView } from "./DiffHunk";
import { applySuggestion, useOnReviewBranch } from "./suggestion";
import styles from "./comments.module.css";

/** The diff of a suggestion: the commented lines removed, the suggested ones added. */
function suggestionHunk(target: SuggestionTarget, lines: readonly string[]): PatchHunk {
  const start = target.startLineIndex ?? 0;
  return {
    startLineBefore: start,
    startLineAfter: start,
    lines: [
      ...target.originalLines.map((text) => ({ type: "REMOVE" as const, text })),
      ...lines.map((text) => ({ type: "ADD" as const, text })),
    ],
  };
}

function CommitPopup({
  anchor,
  onCommit,
  onClose,
}: {
  anchor: Element | null;
  onCommit: (m: string) => void;
  onClose: () => void;
}) {
  const t = useTx();
  const [message, setMessage] = useState("");
  const [empty, setEmpty] = useState(false);
  const commit = () => {
    if (!message.trim()) return setEmpty(true);
    onCommit(message);
    onClose();
  };
  return (
    <Popup open anchor={anchor} onClose={onClose} placement="bottom-end" trapFocus aria-label={t("Commit")}>
      <div className={styles.commitPopup}>
        <textarea
          data-autofocus
          aria-label={t("Commit message")}
          placeholder={t("Commit message")}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setEmpty(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        {empty && (
          <span className={styles.error}>
            <Icon name="error" size={14} /> {t("Commit message is empty")}
          </span>
        )}
        <div className={styles.buttons}>
          <Button variant="primary" onClick={commit}>
            Commit
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Popup>
  );
}

function SuggestionBox({
  number,
  thread,
  target,
  lines,
}: {
  number: number;
  thread: GHPullRequestReviewThread;
  target: SuggestionTarget;
  lines: string[];
}) {
  const t = useTx();
  const onBranch = useOnReviewBranch(number);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [commit, setCommit] = useState(false);
  const [arrow, setArrow] = useState<HTMLButtonElement | null>(null);
  const reason = suggestionDisabledReason(target.applicability, onBranch ?? false);
  const disabled = busy || reason !== null;
  const run = async (message?: string) => {
    setBusy(true);
    try {
      await applySuggestion(number, thread, target, lines, message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.suggestion}>
      <div className={styles.suggestionTop}>
        <span className={styles.suggestionTitle}>{t("Suggested change")}</span>
        <span className={styles.split} {...(reason ? tooltipAttrs(t(reason)) : {})}>
          <Button size="small" disabled={disabled} onClick={() => void run()}>
            Apply Locally
          </Button>
          <Button ref={setArrow} size="small" disabled={disabled} aria-label={t("More")} onClick={() => setMenu(true)}>
            <Icon name="chevron-down" size={14} />
          </Button>
        </span>
      </div>
      <HunkView hunk={suggestionHunk(target, lines)} />
      <Menu
        open={menu}
        anchor={arrow}
        onClose={() => setMenu(false)}
        placement="bottom-end"
        items={[{ label: "Commit…", run: () => setCommit(true) }]}
      />
      {commit && <CommitPopup anchor={arrow} onCommit={(m) => void run(m)} onClose={() => setCommit(false)} />}
    </div>
  );
}

/** The body of a review comment in `thread`, its suggested changes as boxes. */
export function ReviewCommentBody({
  number,
  thread,
  body,
}: {
  number: number;
  thread: GHPullRequestReviewThread;
  body: string;
}) {
  const blocks = splitSuggestions(body);
  if (!blocks.some((b) => b.type === "suggestion")) return <Markdown text={body} />;
  const target = suggestionTarget({ ...thread, diffHunk: threadDiffHunk(thread) });
  return (
    <div>
      {blocks.map((b, i) =>
        b.type === "markdown" ? (
          <Markdown key={i} text={b.text} />
        ) : (
          <SuggestionBox key={i} number={number} thread={thread} target={target} lines={b.lines} />
        ),
      )}
    </div>
  );
}
